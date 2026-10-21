/**
 * 系统路由：健康检查、模型设置、写法规则、用量统计、导出。
 */
import { Router } from 'express';
import { all, get, run, now, parseField } from '../db.js';
import { getAISettings, isMockMode, testConnection } from '../ai.js';
import { buildDocx, buildEpub } from '../export.js';

const r = Router();

/* ============ 模型设置 ============ */

r.get('/settings', (req, res) => {
  const s = getAISettings();
  res.json({ ai: s, mock: isMockMode(s) });
});

r.put('/settings', (req, res) => {
  const b = req.body || {};
  const prev = getAISettings();
  const next = {
    provider: b.provider === 'openai' || b.provider === 'anthropic' ? b.provider : 'mock',
    baseUrl: String(b.baseUrl || '').trim(),
    apiKey: String(b.apiKey || '').trim() || (b.provider === prev.provider ? prev.apiKey : ''),
    models: {
      planner: String(b.models?.planner || '').trim(),
      writer: String(b.models?.writer || '').trim(),
      reviewer: String(b.models?.reviewer || '').trim(),
    },
  };
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'ai', JSON.stringify(next));
  res.json({ ai: next, mock: isMockMode(next) });
});

r.post('/settings/test', async (req, res) => {
  try {
    const result = await testConnection(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/** 拉取服务商的模型列表（GET {baseUrl}/models），供设置页下拉选择 */
r.post('/settings/models', async (req, res) => {
  const b = req.body || {};
  const provider = b.provider === 'anthropic' ? 'anthropic' : 'openai';
  const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(b.apiKey || '').trim();
  if (!baseUrl) return res.status(400).json({ error: '请先填写 API 地址' });
  try {
    const headers = provider === 'anthropic'
      ? { ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' }
      : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
    const resp = await fetch(`${baseUrl}/models${provider === 'anthropic' ? '?limit=100' : ''}`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    const text = resp.ok ? '' : (await resp.text().catch(() => '')).slice(0, 300);
    if (!resp.ok) return res.status(502).json({ error: `HTTP ${resp.status}${text ? `：${text}` : ''}` });
    const data = await resp.json();
    const list = (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [])
      .map((x) => (typeof x === 'string' ? x : x?.id))
      .filter(Boolean);
    res.json({ models: [...new Set(list)].sort() });
  } catch (e) {
    res.status(502).json({ error: e?.message || '获取模型列表失败' });
  }
});

/* ============ 写法规则 ============ */

r.get('/rules', (req, res) => {
  const pid = Number(req.query.projectId) || null;
  const rows = all(
    `SELECT * FROM style_rules WHERE project_id IS NULL ${pid ? 'OR project_id = ?' : ''} ORDER BY kind, id`,
    ...(pid ? [pid] : [])
  );
  res.json(rows);
});

r.post('/rules', (req, res) => {
  const { projectId = null, kind = 'style', name = '', content = '' } = req.body || {};
  if (!String(name).trim() || !String(content).trim()) return res.status(400).json({ error: '规则名与内容不能为空' });
  const info = run('INSERT INTO style_rules (project_id, kind, name, content, enabled) VALUES (?,?,?,?,1)',
    projectId ? Number(projectId) : null, kind === 'anti_ai' ? 'anti_ai' : 'style', String(name).slice(0, 60), String(content).slice(0, 1000));
  res.json(get('SELECT * FROM style_rules WHERE id = ?', info.lastInsertRowid));
});

r.put('/rules/:rid', (req, res) => {
  const row = get('SELECT * FROM style_rules WHERE id = ?', Number(req.params.rid));
  if (!row) return res.status(404).json({ error: '规则不存在' });
  const b = req.body || {};
  run('UPDATE style_rules SET name = ?, content = ?, enabled = ? WHERE id = ?',
    b.name ?? row.name, b.content ?? row.content, b.enabled === undefined ? row.enabled : (b.enabled ? 1 : 0), row.id);
  res.json(get('SELECT * FROM style_rules WHERE id = ?', row.id));
});

r.delete('/rules/:rid', (req, res) => {
  const row = get('SELECT * FROM style_rules WHERE id = ?', Number(req.params.rid));
  if (!row) return res.status(404).json({ error: '规则不存在' });
  run('DELETE FROM style_rules WHERE id = ?', row.id);
  res.json({ ok: true });
});

const ANTI_AI_PRESETS = [
  ['避免万能动词', '把「看」「走」「拿」等万能动词换成更具体的动作；能用一个精准动词解决的，不用副词修饰的弱动词。'],
  ['五感落地', '每个场景至少调用两种以上感官（视、听、嗅、触、温感），禁止只堆视觉形容词。'],
  ['对话去水', '删除不承载信息或性格的寒暄对话；两人对话连续超过六轮时，插入动作或环境反应打断。'],
  ['开局即冲突', '章节前 200 字内必须出现具体的张力（事件、反常或分歧），禁止以天气、起床、回忆开头。'],
  ['禁总结式结尾', '章节结尾停在动作或对话上，禁止「他知道，一切才刚刚开始」式的套话总结。'],
];

r.post('/rules/seed-anti-ai', (req, res) => {
  const existing = new Set(all("SELECT name FROM style_rules WHERE kind = 'anti_ai'").map((x) => x.name));
  let added = 0;
  for (const [name, content] of ANTI_AI_PRESETS) {
    if (existing.has(name)) continue;
    run("INSERT INTO style_rules (project_id, kind, name, content, enabled) VALUES (NULL, 'anti_ai', ?, ?, 1)", name, content);
    added++;
  }
  res.json({ added, rules: all('SELECT * FROM style_rules ORDER BY kind, id') });
});

/* ============ 用量统计 ============ */

r.get('/usage', (req, res) => {
  const pid = Number(req.query.projectId) || null;
  const step = String(req.query.step || '').trim();
  const conds = [];
  const args = [];
  if (pid) { conds.push('project_id = ?'); args.push(pid); }
  if (step) { conds.push('step = ?'); args.push(step); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = all(`SELECT * FROM ai_calls ${where} ORDER BY id DESC LIMIT 500`, ...args);
  const totals = get(`SELECT COUNT(*) AS calls,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END), 0) AS estimated
    FROM ai_calls ${where}`, ...args);
  const byModel = all(`SELECT model, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens
    FROM ai_calls ${where} GROUP BY model ORDER BY calls DESC`, ...args);
  const byStep = all(`SELECT step, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens
    FROM ai_calls ${where} GROUP BY step ORDER BY calls DESC`, ...args);
  res.json({ rows, totals, byModel, byStep });
});

/* ============ 写作统计 ============ */

function dayKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

r.get('/stats', (req, res) => {
  const pid = Number(req.query.projectId) || null;
  const n = Math.min(90, Math.max(7, Number(req.query.days) || 14));
  if (!pid) return res.json({ days: [], today: 0, total: 0, streak: 0, bestDay: null });
  const rows = all('SELECT day, words FROM writing_log WHERE project_id = ? ORDER BY day', pid);
  const map = new Map(rows.map((x) => [x.day, x.words]));
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    days.push({ day: key, words: map.get(key) || 0 });
  }
  const today = map.get(dayKey()) || 0;
  const total = rows.reduce((s, x) => s + x.words, 0);
  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const w = map.get(dayKey(d)) || 0;
    if (w > 0) streak++;
    else if (i === 0) continue; // 今天还没写，不打断连续天数
    else break;
  }
  const best = rows.reduce((a, x) => (x.words > (a?.words || 0) ? x : a), null);
  res.json({ days, today, total, streak, bestDay: best });
});

/* ============ 导出 ============ */

r.get('/projects/:id/export', (req, res) => {
  const p = get('SELECT * FROM projects WHERE id = ?', Number(req.params.id));
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const volumes = all('SELECT * FROM volumes WHERE project_id = ? ORDER BY idx', p.id);
  const chapters = all('SELECT * FROM chapters WHERE project_id = ? ORDER BY idx, id', p.id);
  const fmt = ['txt', 'md', 'docx', 'epub'].includes(String(req.query.format)) ? String(req.query.format) : 'md';

  if (fmt === 'docx' || fmt === 'epub') {
    const buf = fmt === 'docx' ? buildDocx(p, volumes, chapters) : buildEpub(p, volumes, chapters);
    res.setHeader('Content-Type', fmt === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/epub+zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.title)}.${fmt}`);
    return res.send(buf);
  }

  const d = parseField(p.direction, null);
  const has = (v) => chapters.filter((c) => c.volume_id === v.id);
  const orphans = chapters.filter((c) => !c.volume_id || !volumes.some((v) => v.id === c.volume_id));

  const lines = [];
  if (fmt === 'md') {
    lines.push(`# ${p.title}`, '');
    if (p.premise) lines.push(`> 灵感：${p.premise}`, '');
    if (d?.logline) lines.push(`> ${d.logline}`, d?.genre ? `> 题材：${d.genre}` : '', '');
    for (const v of volumes) {
      lines.push(`## ${v.title}`, '');
      if (v.summary) lines.push(v.summary, '');
      for (const c of has(v)) lines.push(`### 第${c.idx}章 ${c.title}`, '', c.content, '');
    }
    if (orphans.length) {
      lines.push('## 正文', '');
      for (const c of orphans) lines.push(`### 第${c.idx}章 ${c.title}`, '', c.content, '');
    }
  } else {
    lines.push(p.title, '');
    if (p.premise) lines.push(`灵感：${p.premise}`, '');
    for (const v of volumes) {
      lines.push(`【${v.title}】`, '');
      if (v.summary) lines.push(v.summary, '');
      for (const c of has(v)) lines.push(`第${c.idx}章 ${c.title}`, '', c.content, '');
    }
    for (const c of orphans) lines.push(`第${c.idx}章 ${c.title}`, '', c.content, '');
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  res.setHeader('Content-Type', fmt === 'txt' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.title)}.${fmt}`);
  res.send(text);
});

export default r;
