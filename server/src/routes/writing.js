/**
 * 写作路由：正文生成（SSE 流式）、续写、改写、章节检查、写后整理、正文保存、版本历史。
 * 生成结果不直接落库——「人管控」：由作者在编辑器中采纳后经 content 接口保存。
 */
import { Router } from 'express';
import { all, get, run, now, parseField } from '../db.js';
import { callAI } from '../ai.js';
import * as P from '../prompts.js';
import * as M from '../mock.js';
import { parseJSONLoose, countWords, sseFrame } from '../util.js';
import {
  chapterContext, chapterTarget, mockCtx, postWriteSync, reviewChapter, saveChapterContent,
  snapshotChapter,
} from '../pipeline.js';

const r = Router();

const proj = (id) => get('SELECT * FROM projects WHERE id = ?', Number(id));
const chapter = (pid, cid) => {
  const c = get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', Number(cid), Number(pid));
  return c ? { ...c, cast: parseField(c.cast_names, []), review: parseField(c.review, null) } : null;
};

function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/* ============ 单章正文（含 content，供去AI味等页面读取） ============ */
r.get('/:id/chapters/:cid', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  res.json({ ...c, content: c.content || '' });
});

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
  const ctx = chapterContext(p, c);
  const { system, user } = P.continueWrite(p, c, before, target, ctx);

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
    const review = await reviewChapter(p, c);
    res.json({ review });
  } catch (e) {
    res.status(502).json({ error: e.message || '检查失败', raw: e.raw });
  }
});

/* ============ 写后整理（摘要 + 角色状态 + 伏笔线索） ============ */
r.post('/:id/chapters/:cid/sync-state', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  if (!c.content || !c.content.trim()) return res.status(400).json({ error: '本章还没有正文' });
  try {
    const result = await postWriteSync(p, c);
    run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), p.id);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message || '写后整理失败' });
  }
});

/* ============ 正文保存（编辑器自动保存） ============ */
r.put('/:id/chapters/:cid/content', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const reason = String(req.query.reason || 'autosave');
  const result = await saveChapterContent(p, c, req.body?.content ?? '', {
    reason,
    sync: req.query.sync === '1',
    /* 生成 / 批量等关键节点必留版本；普通自动保存按 60 秒合并 */
    forceSnapshot: req.query.force === '1' || reason === 'generate' || reason === 'batch',
  });
  res.json({ ...result, chapter: chapter(p.id, c.id) });
});

/* ============ 版本历史 ============ */

r.get('/:id/chapters/:cid/revisions', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  const rows = all(
    `SELECT id, word_count, reason, created_at, substr(content, 1, 90) AS preview
     FROM chapter_revisions WHERE chapter_id = ? ORDER BY id DESC LIMIT 80`,
    c.id
  );
  res.json(rows);
});

r.get('/:id/chapters/:cid/revisions/:rid', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const row = get('SELECT * FROM chapter_revisions WHERE id = ? AND project_id = ? AND chapter_id = ?',
    Number(req.params.rid), p.id, Number(req.params.cid));
  if (!row) return res.status(404).json({ error: '版本不存在' });
  res.json(row);
});

r.post('/:id/chapters/:cid/revisions/:rid/restore', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  const rev = get('SELECT * FROM chapter_revisions WHERE id = ? AND project_id = ? AND chapter_id = ?',
    Number(req.params.rid), p.id, c.id);
  if (!rev) return res.status(404).json({ error: '版本不存在' });
  /* 回滚前先为当前正文留档，避免误覆盖无法找回 */
  if (String(c.content || '').trim()) {
    snapshotChapter(p.id, c.id, c.content, c.word_count, 'restore-prev', true);
  }
  const result = await saveChapterContent(p, c, rev.content, {
    reason: 'restore', sync: false, forceSnapshot: true,
  });
  res.json({ ...result, chapter: chapter(p.id, c.id) });
});

/* ============ 手动留一个版本 ============ */
r.post('/:id/chapters/:cid/revisions', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  if (!c.content || !c.content.trim()) return res.status(400).json({ error: '本章还没有正文' });
  snapshotChapter(p.id, c.id, c.content, c.word_count, req.body?.reason || 'manual', true);
  res.json({ ok: true });
});

export default r;
