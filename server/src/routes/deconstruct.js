/**
 * 拆书路由：导入参考作品文本 → 自动分章 → AI 拆解结构 / 人物 / 写法 → 一键转成写法规则。
 */
import { Router } from 'express';
import { all, get, run, now, parseField } from '../db.js';
import { callAI } from '../ai.js';
import * as P from '../prompts.js';
import * as M from '../mock.js';
import { parseJSONLoose } from '../util.js';
import { splitChapters, analyzeStats, buildDigest, normalizeAnalysis } from '../deconstruct.js';

const r = Router();

const proj = (id) => get('SELECT * FROM projects WHERE id = ?', Number(id));
const decode = (row) => ({
  ...row,
  source: undefined,
  chapters: parseField(row.chapters, []),
  result: parseField(row.result, null),
});

r.get('/:id/deconstructions', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const rows = all('SELECT * FROM deconstructions WHERE project_id = ? ORDER BY id DESC', p.id);
  res.json(rows.map(decode));
});

r.get('/:id/deconstructions/:did', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const row = get('SELECT * FROM deconstructions WHERE id = ? AND project_id = ?', Number(req.params.did), p.id);
  if (!row) return res.status(404).json({ error: '拆书记录不存在' });
  res.json(decode(row));
});

r.post('/:id/deconstructions', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const raw = String(req.body?.text || '');
  if (raw.trim().length < 200) return res.status(400).json({ error: '请先粘贴或导入至少 200 字的参考正文' });
  const title = String(req.body?.title || '').trim().slice(0, 80) || '参考作品';

  const chapters = splitChapters(raw.slice(0, 1_500_000));
  if (!chapters.length) return res.status(400).json({ error: '没有识别到可分析的正文内容' });

  const stats = analyzeStats(chapters);
  const digest = buildDigest(chapters);
  const t = now();
  const info = run(
    `INSERT INTO deconstructions (project_id, title, chapter_count, word_count, chapters, source, result, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    p.id, title, chapters.length, stats.totalWords,
    JSON.stringify(chapters.map((c) => ({ idx: c.idx, title: c.title, words: c.words }))),
    raw.slice(0, 300_000), null, 'analyzing', t, t
  );
  const id = Number(info.lastInsertRowid);

  try {
    const { system, user } = P.deconstruct(title, stats, digest);
    const out = await callAI({
      task: 'planner', step: 'deconstruct', system, user, projectId: p.id,
      mock: () => M.deconstruct(title, stats),
    });
    const analysis = normalizeAnalysis(parseJSONLoose(out.text));
    if (!analysis || (!analysis.summary && !analysis.structure.pattern)) {
      const err = new Error('AI 返回的拆解结果无法解析，请重试');
      err.raw = String(out.text || '').slice(0, 300);
      throw err;
    }
    run('UPDATE deconstructions SET result = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?',
      JSON.stringify(analysis), 'done', now(), id);
    res.json(decode(get('SELECT * FROM deconstructions WHERE id = ?', id)));
  } catch (e) {
    run('UPDATE deconstructions SET status = ?, error = ?, updated_at = ? WHERE id = ?',
      'error', String(e.message || e).slice(0, 500), now(), id);
    res.status(502).json({ error: e.message || '拆书失败', id });
  }
});

r.delete('/:id/deconstructions/:did', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const row = get('SELECT * FROM deconstructions WHERE id = ? AND project_id = ?', Number(req.params.did), p.id);
  if (!row) return res.status(404).json({ error: '拆书记录不存在' });
  run('DELETE FROM deconstructions WHERE id = ?', row.id);
  res.json({ ok: true });
});

/** 把拆解出的写法规则写入本书的写法规则库 */
r.post('/:id/deconstructions/:did/to-rules', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const row = get('SELECT * FROM deconstructions WHERE id = ? AND project_id = ?', Number(req.params.did), p.id);
  if (!row) return res.status(404).json({ error: '拆书记录不存在' });
  const analysis = parseField(row.result, null);
  if (!analysis?.rules?.length) return res.status(400).json({ error: '这条拆书记录还没有可用的写法规则' });

  const existing = new Set(all('SELECT name FROM style_rules WHERE project_id = ?', p.id).map((x) => x.name));
  let added = 0;
  for (const rule of analysis.rules) {
    const name = String(rule?.name || '').trim().slice(0, 60);
    const content = String(rule?.content || '').trim().slice(0, 400);
    if (!name || !content || existing.has(name)) continue;
    run('INSERT INTO style_rules (project_id, kind, name, content, enabled) VALUES (?,?,?,?,1)',
      p.id, rule.kind === 'anti_ai' ? 'anti_ai' : 'style', name, content);
    existing.add(name);
    added++;
  }
  res.json({ added, rules: all('SELECT * FROM style_rules WHERE project_id = ? ORDER BY kind, id', p.id) });
});

export default r;
