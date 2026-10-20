/**
 * 去AI味路由：配置读写、章节扫描、按命中项改写（SSE）。
 * 扫描只读不落库；改写结果由作者在页面上确认后替换并保存。
 */
import { Router } from 'express';
import { get } from '../db.js';
import { callAI } from '../ai.js';
import * as P from '../prompts.js';
import * as M from '../mock.js';
import { sseFrame } from '../util.js';
import { getFlavorConfig, saveFlavorConfig, buildDefaultRules, scanFlavor } from '../flavor.js';

const r = Router();

const proj = (id) => get('SELECT * FROM projects WHERE id = ?', Number(id));
const chapter = (pid, cid) => get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', Number(cid), Number(pid));

/* ============ 配置 ============ */

r.get('/flavor/settings', (req, res) => {
  const cfg = getFlavorConfig();
  res.json({ ...cfg, defaults: { ...cfg, rules: buildDefaultRules() } });
});

r.put('/flavor/settings', (req, res) => {
  res.json(saveFlavorConfig(req.body || {}));
});

r.post('/flavor/rules/reset', (req, res) => {
  const cfg = getFlavorConfig();
  res.json(saveFlavorConfig({ ...cfg, rules: buildDefaultRules() }));
});

/* ============ 扫描 ============ */

r.post('/projects/:id/chapters/:cid/flavor-scan', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : c.content;
  if (!String(text || '').trim()) return res.status(400).json({ error: '本章还没有正文，先写点内容再扫描' });

  try {
    const report = await scanFlavor(text, { projectId: p.id, chapterId: c.id });
    res.json({ ...report, chapterId: c.id, text });
  } catch (e) {
    res.status(502).json({ error: e?.message || '扫描失败' });
  }
});

/* ============ 按命中项改写（SSE） ============ */

r.post('/projects/:id/chapters/:cid/flavor-rewrite', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const { selection = '', hits = [], before = '', after = '' } = req.body || {};
  if (!String(selection).trim()) return res.status(400).json({ error: '缺少要改写的片段' });
  const { system, user } = P.flavorRewrite(selection, hits, before, after);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) { closed = true; ac.abort(); } });
  const send = (event, data) => { if (!closed) res.write(sseFrame(event, data)); };

  send('start', { chapterId: c.id, mode: 'flavor-rewrite' });
  try {
    const out = await callAI({
      task: 'writer', step: 'flavor_rewrite', system, user,
      projectId: p.id, chapterId: c.id, stream: true, signal: ac.signal,
      onDelta: (d) => send('delta', { text: d }),
      mock: () => M.rewriteText(selection, '去掉AI腔，保持原意'),
    });
    send('done', { text: out.text, usage: out.usage, model: out.model });
  } catch (e) {
    send('error', { message: e?.message || '改写失败' });
  }
  res.end();
});

export default r;
