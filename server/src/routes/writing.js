/**
 * 写作路由：正文生成（SSE 流式）、续写、改写、章节检查、角色状态同步、正文保存。
 * 生成结果不直接落库——「人管控」：由作者在编辑器中采纳后经 content 接口保存。
 */
import { Router } from 'express';
import { all, get, run, now, parseField } from '../db.js';
import { callAI } from '../ai.js';
import * as P from '../prompts.js';
import * as M from '../mock.js';
import { parseJSONLoose, countWords, sseFrame } from '../util.js';

const r = Router();

const proj = (id) => get('SELECT * FROM projects WHERE id = ?', Number(id));
const chapter = (pid, cid) => {
  const c = get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', Number(cid), Number(pid));
  return c ? { ...c, cast: parseField(c.cast_names, []), review: parseField(c.review, null) } : null;
};
const touch = (id) => run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), id);

/** 组装本章上下文：世界规则、出场人物、写法规则、上一章结尾 */
export function chapterContext(p, c) {
  const world = all('SELECT * FROM world_entries WHERE project_id = ?', p.id);
  const chars = all('SELECT * FROM characters WHERE project_id = ?', p.id);
  const castSet = new Set(c.cast || []);
  let useChars = chars.filter((ch) => castSet.has(ch.name));
  if (!useChars.length) useChars = chars.filter((ch) => ch.role === '主角' || ch.role === '反派');
  if (!useChars.length) useChars = chars.slice(0, 4);
  const rules = all(
    'SELECT * FROM style_rules WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY project_id DESC, id',
    p.id
  );
  const prev = get(
    'SELECT title, content FROM chapters WHERE project_id = ? AND word_count > 0 AND idx < ? ORDER BY idx DESC LIMIT 1',
    p.id, c.idx
  );
  return {
    world, useChars, rules,
    prevTitle: prev?.title || null,
    tail: prev?.content ? prev.content.slice(-620) : '',
    allChars: chars,
  };
}

export function chapterTarget(p, c) {
  if (p.type === 'short' && p.target_words > 0) {
    const total = get('SELECT COUNT(*) AS n FROM chapters WHERE project_id = ?', p.id).n || 1;
    return Math.max(500, Math.round(p.target_words / total));
  }
  return 2600;
}

function mockCtx(c, ctx) {
  const names = c.cast?.length ? c.cast : ctx.useChars.map((ch) => ch.name);
  const place = ctx.world.find((w) => w.category === '地理')?.name || '临渊城';
  const item = ctx.world.find((w) => w.category === '物品')?.name || '罗盘';
  return { castNames: names.length ? names : ['林渡'], place, item, otherName: ctx.useChars[1]?.name };
}

function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/* ============ 整章生成（SSE） ============ */
r.post('/:id/chapters/:cid/write', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const ctx = chapterContext(p, c);
  ctx.target = chapterTarget(p, c);
  const { system, user } = P.chapterWrite(p, c, ctx);

  sseInit(res);
  let closed = false;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) { closed = true; ac.abort(); } });
  const send = (event, data) => { if (!closed) res.write(sseFrame(event, data)); };

  send('start', { chapterId: c.id, idx: c.idx, title: c.title, target: ctx.target, prevTitle: ctx.prevTitle });
  try {
    const out = await callAI({
      task: 'writer', step: 'write', system, user,
      projectId: p.id, chapterId: c.id, stream: true, signal: ac.signal,
      onDelta: (d) => send('delta', { text: d }),
      mock: () => M.chapterContent(p, c, mockCtx(c, ctx), ctx.target),
    });
    send('done', { text: out.text, wordCount: countWords(out.text), usage: out.usage, model: out.model });
  } catch (e) {
    send('error', { message: e?.message || '正文生成失败' });
  }
  res.end();
});

/* ============ 光标续写（SSE） ============ */
r.post('/:id/chapters/:cid/continue', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const content = String(req.body?.content ?? c.content ?? '');
  const cursor = Math.max(0, Math.min(Number(req.body?.cursor ?? content.length) || 0, content.length));
  const before = content.slice(Math.max(0, cursor - 1200), cursor);
  const target = Math.max(200, Math.min(Number(req.body?.target) || 800, 3000));
  const { system, user } = P.continueWrite(p, c, before, target);

  sseInit(res);
  let closed = false;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) { closed = true; ac.abort(); } });
  const send = (event, data) => { if (!closed) res.write(sseFrame(event, data)); };

  send('start', { chapterId: c.id, mode: 'continue', target });
  try {
    const out = await callAI({
      task: 'writer', step: 'continue', system, user,
      projectId: p.id, chapterId: c.id, stream: true, signal: ac.signal,
      onDelta: (d) => send('delta', { text: d }),
      mock: () => M.continueText(p, c, before, target),
    });
    send('done', { text: out.text, wordCount: countWords(out.text), usage: out.usage, model: out.model });
  } catch (e) {
    send('error', { message: e?.message || '续写失败' });
  }
  res.end();
});

/* ============ 局部改写（SSE） ============ */
r.post('/:id/chapters/:cid/rewrite', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const { selection = '', instruction = '在不改变情节的前提下提升文笔，消除AI腔', before = '', after = '' } = req.body || {};
  if (!String(selection).trim()) return res.status(400).json({ error: '请先在编辑器中选中要改写的片段' });
  const { system, user } = P.rewrite(p, selection, instruction, before, after);

  sseInit(res);
  let closed = false;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) { closed = true; ac.abort(); } });
  const send = (event, data) => { if (!closed) res.write(sseFrame(event, data)); };

  send('start', { chapterId: c.id, mode: 'rewrite', length: countWords(selection) });
  try {
    const out = await callAI({
      task: 'writer', step: 'rewrite', system, user,
      projectId: p.id, chapterId: c.id, stream: true, signal: ac.signal,
      onDelta: (d) => send('delta', { text: d }),
      mock: () => M.rewriteText(selection, instruction),
    });
    send('done', { text: out.text, usage: out.usage, model: out.model });
  } catch (e) {
    send('error', { message: e?.message || '改写失败' });
  }
  res.end();
});

/* ============ 章节检查 ============ */
r.post('/:id/chapters/:cid/review', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  if (!c.content || !c.content.trim()) return res.status(400).json({ error: '本章还没有正文，请先生成或撰写' });

  try {
    const ctx = chapterContext(p, c);
    const { system, user } = P.review(p, c, ctx);
    const out = await callAI({
      task: 'reviewer', step: 'review', system, user,
      projectId: p.id, chapterId: c.id,
      mock: () => M.review(c),
    });
    const rv = parseJSONLoose(out.text);
    if (!rv || typeof rv.score !== 'number') {
      return res.status(502).json({ error: 'AI 返回的检查结果无法解析，请重试', raw: out.text.slice(0, 300) });
    }
    rv.summary = String(rv.summary || '');
    rv.issues = Array.isArray(rv.issues)
      ? rv.issues.filter((i) => i?.problem).map((i) => ({
          severity: ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium',
          type: String(i.type || '其他'),
          location: String(i.location || ''),
          problem: String(i.problem || ''),
          suggestion: String(i.suggestion || ''),
        }))
      : [];
    run('UPDATE chapters SET review = ?, updated_at = ? WHERE id = ?', JSON.stringify(rv), now(), c.id);
    touch(p.id);
    res.json({ review: rv });
  } catch (e) {
    res.status(502).json({ error: e.message || '检查失败' });
  }
});

/* ============ 角色状态同步 ============ */
async function syncState(p, c) {
  const chars = all('SELECT * FROM characters WHERE project_id = ?', p.id);
  if (!chars.length) return [];
  const { system, user } = P.stateSync(c, chars);
  const out = await callAI({
    task: 'reviewer', step: 'state_sync', system, user,
    projectId: p.id, chapterId: c.id,
    mock: () => M.stateSync(c, chars),
  });
  const arr = parseJSONLoose(out.text);
  if (!Array.isArray(arr)) throw new Error('AI 返回的状态更新无法解析，请重试');
  const updated = [];
  for (const u of arr) {
    if (!u?.name || !u.status) continue;
    const info = run('UPDATE characters SET status = ?, updated_at = ? WHERE project_id = ? AND name = ?',
      String(u.status).slice(0, 400), now(), p.id, String(u.name));
    if (info.changes > 0) updated.push({ name: u.name, status: u.status });
  }
  return updated;
}

r.post('/:id/chapters/:cid/sync-state', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  if (!c.content || !c.content.trim()) return res.status(400).json({ error: '本章还没有正文' });
  try {
    const updated = await syncState(p, c);
    touch(p.id);
    res.json({ updated });
  } catch (e) {
    res.status(502).json({ error: e.message || '状态同步失败' });
  }
});

/* ============ 正文保存（编辑器自动保存） ============ */
r.put('/:id/chapters/:cid/content', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const content = String(req.body?.content ?? '');
  const wc = countWords(content);
  const newStatus = wc > 0 && c.status === 'planned' ? 'draft' : c.status;
  run('UPDATE chapters SET content = ?, word_count = ?, status = ?, updated_at = ? WHERE id = ?',
    content, wc, newStatus, now(), c.id);
  if (wc > 0) {
    run(`UPDATE projects SET status = 'writing', updated_at = ? WHERE id = ? AND status IN ('direction', 'building', 'planned', 'writing')`, now(), p.id);
  } else {
    touch(p.id);
  }

  let synced = null;
  let syncError = null;
  if (req.query.sync === '1' && p.sync_state && wc > 0) {
    try {
      const fresh = chapter(p.id, c.id);
      synced = await syncState(p, fresh);
    } catch (e) {
      syncError = e.message;
    }
  }
  res.json({ ok: true, wordCount: wc, status: newStatus, synced, syncError });
});

export default r;
