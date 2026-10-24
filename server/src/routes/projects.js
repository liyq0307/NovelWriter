/**
 * 项目（作品）与创作管线路由：
 * CRUD、AI 方向、世界设定、角色关系、卷纲、拆章、章节管理
 */
import { Router } from 'express';
import { all, get, run, now, parseField } from '../db.js';
import { callAI } from '../ai.js';
import * as P from '../prompts.js';
import * as M from '../mock.js';
import { parseJSONLoose, parseJSONArraySalvage, countWords, normalizeText, isSameFact } from '../util.js';
import { searchProject, dropProjectIndex } from '../search.js';

const r = Router();

const proj = (id) => get('SELECT * FROM projects WHERE id = ?', Number(id));
const touch = (id) => run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), id);
const withJSON = (p) => ({ ...p, direction: parseField(p.direction, null), contract: parseField(p.contract, null) });

/* ============ 列表 / 详情 ============ */

r.get('/', (req, res) => {
  const rows = all('SELECT * FROM projects ORDER BY updated_at DESC');
  res.json(rows.map((p) => {
    const c = get('SELECT COUNT(*) AS n, COALESCE(SUM(word_count), 0) AS w FROM chapters WHERE project_id = ?', p.id);
    const d = get('SELECT COUNT(*) AS n FROM chapters WHERE project_id = ? AND word_count > 0', p.id);
    return { ...withJSON(p), chapters_total: c.n, chapters_done: d.n, word_total: c.w };
  }));
});

r.post('/', (req, res) => {
  const { premise = '', title = '', type = 'novel', targetWords = 0 } = req.body || {};
  if (!String(premise).trim()) return res.status(400).json({ error: '请先写下你的灵感，哪怕只有一句话' });
  const t = now();
  const info = run(
    'INSERT INTO projects (title, type, status, premise, target_words, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    String(title).trim() || '未命名作品',
    type === 'short' ? 'short' : 'novel',
    'idea',
    String(premise).trim(),
    Number(targetWords) || 0,
    t, t
  );
  res.json(withJSON(proj(info.lastInsertRowid)));
});

r.get('/:id', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const volumes = all('SELECT * FROM volumes WHERE project_id = ? ORDER BY idx, id', p.id);
  const chapters = all(`SELECT id, volume_id, idx, title, brief, scenes, cast_names AS cast, hook, status, word_count, summary, review, created_at, updated_at
                        FROM chapters WHERE project_id = ? ORDER BY idx, id`, p.id)
    .map((c) => ({ ...c, cast: parseField(c.cast, []), review: parseField(c.review, null) }));
  const world = all('SELECT * FROM world_entries WHERE project_id = ? ORDER BY category, id', p.id);
  const characters = all('SELECT * FROM characters WHERE project_id = ? ORDER BY id', p.id);
  const relations = all('SELECT * FROM relations WHERE project_id = ? ORDER BY id', p.id);
  const threads = all('SELECT * FROM threads WHERE project_id = ? ORDER BY status, last_chapter DESC, id', p.id);
  const facts = all("SELECT * FROM facts WHERE project_id = ? AND status = 'active' ORDER BY id DESC", p.id);
  const w = get('SELECT COALESCE(SUM(word_count), 0) AS w FROM chapters WHERE project_id = ?', p.id);
  res.json({ ...withJSON(p), volumes, chapters, world, characters, relations, threads, facts, word_total: w.w });
});

r.patch('/:id', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const b = req.body || {};
  const fields = [];
  const args = [];
  const set = (col, val) => { fields.push(`${col} = ?`); args.push(val); };
  if (typeof b.title === 'string' && b.title.trim()) set('title', b.title.trim());
  if (typeof b.premise === 'string') set('premise', b.premise.trim());
  if (typeof b.status === 'string') set('status', b.status);
  if (b.direction !== undefined) set('direction', b.direction ? JSON.stringify(b.direction) : null);
  if (b.contract !== undefined) set('contract', b.contract ? JSON.stringify(b.contract) : null);
  if (b.target_words !== undefined) set('target_words', Number(b.target_words) || 0);
  if (b.sync_state !== undefined) set('sync_state', b.sync_state ? 1 : 0);
  if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
  set('updated_at', now());
  run(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, ...args, p.id);
  res.json(withJSON(proj(p.id)));
});

r.delete('/:id', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  for (const t of ['chapters', 'volumes', 'world_entries', 'characters', 'relations', 'threads', 'facts', 'chapter_revisions', 'batches', 'writing_log', 'deconstructions', 'prompt_templates', 'prompt_template_history']) {
    run(`DELETE FROM ${t} WHERE project_id = ?`, p.id);
  }
  dropProjectIndex(p.id);
  run('DELETE FROM projects WHERE id = ?', p.id);
  res.json({ ok: true });
});

/* ============ 全文检索（FTS5，失败降级 LIKE） ============ */

r.get('/:id/search', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: q, hits: [] });
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
  res.json({ query: q, hits: searchProject(p.id, q, limit) });
});

/* ============ AI：开书方向 ============ */

r.post('/:id/directions', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  try {
    const guide = req.body?.guide && typeof req.body.guide === 'object' ? req.body.guide : {};
    const { system, user } = P.directions(p, guide);
    const out = await callAI({ task: 'planner', step: 'directions', system, user, projectId: p.id, mock: () => M.directions(p, guide) });
    let arr = parseJSONLoose(out.text);
    /* 模型偶尔只返回一个方向对象，或包一层 { directions: [...] }，这里做兼容 */
    if (arr && !Array.isArray(arr)) {
      const inner = arr.directions || arr.candidates || arr.data;
      arr = Array.isArray(inner) ? inner : arr.title ? [arr] : null;
    }
    /* 输出被截断导致 JSON 不完整时，保住已经完整的前几个方向 */
    if (!Array.isArray(arr) || !arr.length) arr = parseJSONArraySalvage(out.text);
    if (!Array.isArray(arr) || !arr.length) {
      return res.status(502).json({ error: 'AI 返回的方向无法解析，请重试；若反复失败请换用更稳定的模型', raw: out.text.slice(0, 400) });
    }
    res.json(arr.filter((d) => d && d.title).slice(0, 4));
  } catch (e) {
    res.status(502).json({ error: e.message || '方向生成失败' });
  }
});

/* ============ AI：融合候选方向 ============ */

r.post('/:id/directions/merge', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const raw = Array.isArray(req.body?.candidates) ? req.body.candidates.filter((c) => c && c.title) : [];
  if (raw.length < 2) return res.status(400).json({ error: '请至少选择两个候选方向再融合' });
  const candidates = raw.slice(0, 4).map((c) => ({
    title: String(c.title || '').slice(0, 80),
    genre: String(c.genre || '').slice(0, 40),
    logline: String(c.logline || '').slice(0, 200),
    sellingPoints: Array.isArray(c.sellingPoints) ? c.sellingPoints.map(String).slice(0, 6) : [],
    protagonist: String(c.protagonist || '').slice(0, 400),
    style: String(c.style || '').slice(0, 300),
    audience: String(c.audience || '').slice(0, 120),
    contract: {
      pov: String(c.contract?.pov || '').slice(0, 100),
      tone: String(c.contract?.tone || '').slice(0, 100),
      taboos: Array.isArray(c.contract?.taboos) ? c.contract.taboos.map(String).slice(0, 8) : [],
      arc: String(c.contract?.arc || '').slice(0, 300),
    },
  }));
  const note = String(req.body?.note || '').trim().slice(0, 600);
  const guide = req.body?.guide && typeof req.body.guide === 'object' ? req.body.guide : {};
  try {
    const { system, user } = P.directionsMerge(p, candidates, note, guide);
    const out = await callAI({ task: 'planner', step: 'directions_merge', system, user, projectId: p.id, mock: () => M.directionsMerge(p, candidates, note) });
    let obj = parseJSONLoose(out.text);
    /* 兼容模型把结果包成数组或 { direction: {...} } 的情况 */
    if (Array.isArray(obj)) obj = obj[0];
    if (obj && !obj.title) obj = obj.direction || obj.data || obj.result || obj.candidate;
    if (!obj || !obj.title) {
      return res.status(502).json({ error: 'AI 返回的融合方向无法解析，请重试；若反复失败请换用更稳定的模型', raw: out.text.slice(0, 400) });
    }
    res.json(obj);
  } catch (e) {
    res.status(502).json({ error: e.message || '方向融合失败' });
  }
});

/* ============ 世界设定 ============ */

r.post('/:id/world/generate', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  try {
    const entries = all('SELECT * FROM world_entries WHERE project_id = ?', p.id);
    const { system, user } = P.world(p, entries);
    const out = await callAI({ task: 'planner', step: 'world', system, user, projectId: p.id, mock: () => M.world(p) });
    const arr = parseJSONLoose(out.text);
    if (!Array.isArray(arr)) return res.status(502).json({ error: 'AI 返回的设定无法解析，请重试', raw: out.text.slice(0, 300) });
    const cats = ['地理', '势力', '规则', '物品', '历史', '其他'];
    const existing = new Set(entries.map((e) => `${e.category}|${e.name}`));
    const t = now();
    let added = 0;
    for (const e of arr) {
      if (!e?.name || !e?.content) continue;
      const cat = cats.includes(e.category) ? e.category : '其他';
      if (existing.has(`${cat}|${e.name}`)) continue;
      run('INSERT INTO world_entries (project_id, category, name, content, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        p.id, cat, String(e.name).slice(0, 60), String(e.content).slice(0, 2000), 'ai', t, t);
      existing.add(`${cat}|${e.name}`);
      added++;
    }
    touch(p.id);
    res.json({ added, entries: all('SELECT * FROM world_entries WHERE project_id = ? ORDER BY category, id', p.id) });
  } catch (e) {
    res.status(502).json({ error: e.message || '世界设定生成失败' });
  }
});

r.post('/:id/world', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const { category = '其他', name = '', content = '' } = req.body || {};
  if (!String(name).trim()) return res.status(400).json({ error: '条目名不能为空' });
  const t = now();
  const info = run('INSERT INTO world_entries (project_id, category, name, content, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    p.id, String(category) || '其他', String(name).trim(), String(content), 'human', t, t);
  touch(p.id);
  res.json(get('SELECT * FROM world_entries WHERE id = ?', info.lastInsertRowid));
});

r.put('/:id/world/:wid', (req, res) => {
  const row = get('SELECT * FROM world_entries WHERE id = ?', Number(req.params.wid));
  if (!row) return res.status(404).json({ error: '条目不存在' });
  const { category, name, content } = req.body || {};
  run('UPDATE world_entries SET category = ?, name = ?, content = ?, source = ?, updated_at = ? WHERE id = ?',
    category || row.category, name || row.name, content ?? row.content, row.source === 'human' ? 'human' : (row.source || 'ai'), now(), row.id);
  touch(row.project_id);
  res.json(get('SELECT * FROM world_entries WHERE id = ?', row.id));
});

r.delete('/:id/world/:wid', (req, res) => {
  const row = get('SELECT * FROM world_entries WHERE id = ?', Number(req.params.wid));
  if (!row) return res.status(404).json({ error: '条目不存在' });
  run('DELETE FROM world_entries WHERE id = ?', row.id);
  touch(row.project_id);
  res.json({ ok: true });
});

/* ============ 既定事实（写后自动抽取，可人工删除 / 合并重复） ============ */

r.post('/:id/facts/dedupe', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const rows = all("SELECT * FROM facts WHERE project_id = ? AND status = 'active' ORDER BY id", p.id);
  const kept = [];
  const drop = [];
  for (const row of rows) {
    const hit = kept.findIndex((k) => isSameFact(row.fact, k.fact));
    if (hit === -1) {
      kept.push(row);
      continue;
    }
    // 同一件事保留信息更完整的一条；长度相同则保留更早确立的那条
    if (normalizeText(row.fact).length > normalizeText(kept[hit].fact).length) {
      drop.push(kept[hit].id);
      kept[hit] = row;
    } else {
      drop.push(row.id);
    }
  }
  for (const id of drop) run('DELETE FROM facts WHERE id = ?', id);
  if (drop.length) touch(p.id);
  res.json({ removed: drop.length, kept: kept.length });
});

r.delete('/:id/facts/:fid', (req, res) => {
  const row = get('SELECT * FROM facts WHERE id = ? AND project_id = ?', Number(req.params.fid), Number(req.params.id));
  if (!row) return res.status(404).json({ error: '事实不存在' });
  run('DELETE FROM facts WHERE id = ?', row.id);
  touch(row.project_id);
  res.json({ ok: true });
});

/* ============ 角色与关系 ============ */

r.post('/:id/characters/generate', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  try {
    const entries = all('SELECT * FROM world_entries WHERE project_id = ?', p.id);
    const { system, user } = P.characters(p, entries);
    const out = await callAI({ task: 'planner', step: 'characters', system, user, projectId: p.id, mock: () => M.characters(p) });
    const obj = parseJSONLoose(out.text);
    if (!obj || !Array.isArray(obj.characters)) return res.status(502).json({ error: 'AI 返回的角色无法解析，请重试', raw: out.text.slice(0, 300) });
    const t = now();
    const existing = new Set(all('SELECT name FROM characters WHERE project_id = ?', p.id).map((c) => c.name));
    let added = 0;
    for (const c of obj.characters) {
      if (!c?.name || existing.has(c.name)) continue;
      run('INSERT INTO characters (project_id, name, role, profile, goals, appearance, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        p.id, String(c.name).slice(0, 40), c.role || '配角', String(c.profile || '').slice(0, 1000), String(c.goals || '').slice(0, 500), String(c.appearance || '').slice(0, 300), '', t, t);
      existing.add(c.name);
      added++;
    }
    let relAdded = 0;
    for (const rel of Array.isArray(obj.relations) ? obj.relations : []) {
      if (!rel?.from || !rel?.to) continue;
      run('INSERT INTO relations (project_id, from_name, to_name, type, description) VALUES (?,?,?,?,?)',
        p.id, String(rel.from).slice(0, 40), String(rel.to).slice(0, 40), String(rel.type || '关系').slice(0, 30), String(rel.description || '').slice(0, 200));
      relAdded++;
    }
    touch(p.id);
    res.json({
      added, relAdded,
      characters: all('SELECT * FROM characters WHERE project_id = ? ORDER BY id', p.id),
      relations: all('SELECT * FROM relations WHERE project_id = ? ORDER BY id', p.id),
    });
  } catch (e) {
    res.status(502).json({ error: e.message || '角色生成失败' });
  }
});

r.post('/:id/characters', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const { name = '', role = '配角', profile = '', goals = '', appearance = '', status = '' } = req.body || {};
  if (!String(name).trim()) return res.status(400).json({ error: '角色名不能为空' });
  const t = now();
  const info = run('INSERT INTO characters (project_id, name, role, profile, goals, appearance, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    p.id, String(name).trim(), role, profile, goals, appearance, status, t, t);
  touch(p.id);
  res.json(get('SELECT * FROM characters WHERE id = ?', info.lastInsertRowid));
});

r.put('/:id/characters/:cid', (req, res) => {
  const row = get('SELECT * FROM characters WHERE id = ?', Number(req.params.cid));
  if (!row) return res.status(404).json({ error: '角色不存在' });
  const b = req.body || {};
  run('UPDATE characters SET name = ?, role = ?, profile = ?, goals = ?, appearance = ?, status = ?, updated_at = ? WHERE id = ?',
    b.name || row.name, b.role || row.role, b.profile ?? row.profile, b.goals ?? row.goals, b.appearance ?? row.appearance, b.status ?? row.status, now(), row.id);
  touch(row.project_id);
  res.json(get('SELECT * FROM characters WHERE id = ?', row.id));
});

r.delete('/:id/characters/:cid', (req, res) => {
  const row = get('SELECT * FROM characters WHERE id = ?', Number(req.params.cid));
  if (!row) return res.status(404).json({ error: '角色不存在' });
  run('DELETE FROM characters WHERE id = ?', row.id);
  run('DELETE FROM relations WHERE project_id = ? AND (from_name = ? OR to_name = ?)', row.project_id, row.name, row.name);
  touch(row.project_id);
  res.json({ ok: true });
});

r.post('/:id/relations', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const b = req.body || {};
  /* 兼容两种入参命名：接口契约用 from/to，表单与导入数据用 from_name/to_name */
  const from = String(b.from ?? b.from_name ?? '').trim();
  const to = String(b.to ?? b.to_name ?? '').trim();
  if (!from || !to) return res.status(400).json({ error: '关系需要双方角色名' });
  const type = String(b.type ?? '').trim() || '关系';
  const description = String(b.description ?? '');
  const info = run('INSERT INTO relations (project_id, from_name, to_name, type, description) VALUES (?,?,?,?,?)',
    p.id, from, to, type, description);
  touch(p.id);
  res.json(get('SELECT * FROM relations WHERE id = ?', info.lastInsertRowid));
});

r.delete('/:id/relations/:rid', (req, res) => {
  const row = get('SELECT * FROM relations WHERE id = ?', Number(req.params.rid));
  if (!row) return res.status(404).json({ error: '关系不存在' });
  run('DELETE FROM relations WHERE id = ?', row.id);
  res.json({ ok: true });
});

/* ============ 卷纲 ============ */

r.post('/:id/outline', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const chapters = all('SELECT id, word_count, volume_id FROM chapters WHERE project_id = ?', p.id);
  const written = chapters.filter((c) => c.word_count > 0);
  /* 已有正文时不允许静默重建：必须由前端明确选择覆盖或跳过 */
  const mode = String((req.body || {}).mode || '');
  if (written.length && mode !== 'overwrite' && mode !== 'skip') {
    return res.status(409).json({
      error: '当前作品已有正文章节，请先选择处理方式',
      code: 'HAS_WRITTEN_CHAPTERS',
      stats: {
        chapters: chapters.length,
        written: written.length,
        words: written.reduce((n, c) => n + c.word_count, 0),
        volumes: get('SELECT COUNT(*) AS n FROM volumes WHERE project_id = ?', p.id).n,
      },
    });
  }
  try {
    const entries = all('SELECT * FROM world_entries WHERE project_id = ?', p.id);
    const chars = all('SELECT * FROM characters WHERE project_id = ?', p.id);
    const { system, user } = P.outline(p, entries, chars);
    const out = await callAI({ task: 'planner', step: 'outline', system, user, projectId: p.id, mock: () => M.outline(p) });
    let arr = parseJSONLoose(out.text);
    if (!Array.isArray(arr) || !arr.length) arr = parseJSONArraySalvage(out.text);
    if (!Array.isArray(arr) || !arr.length) return res.status(502).json({ error: 'AI 返回的卷纲无法解析，请重试', raw: out.text.slice(0, 300) });
    const t = now();

    /* 跳过模式：不删除、不改动任何已有卷纲与章节，只把新规划中多出来的卷追加到末尾 */
    if (mode === 'skip') {
      const vols = all('SELECT * FROM volumes WHERE project_id = ? ORDER BY idx', p.id);
      let idx = vols.reduce((m, v) => Math.max(m, v.idx), 0);
      let added = 0;
      for (const v of arr.slice(vols.length, 8)) {
        if (!v?.title) continue;
        run('INSERT INTO volumes (project_id, idx, title, summary, created_at, updated_at) VALUES (?,?,?,?,?,?)',
          p.id, ++idx, String(v.title).slice(0, 80), String(v.summary || '').slice(0, 2000), t, t);
        added++;
      }
      touch(p.id);
      return res.json({
        volumes: all('SELECT * FROM volumes WHERE project_id = ? ORDER BY idx', p.id),
        mode: 'skip', addedVolumes: added, preservedChapters: chapters.length,
      });
    }

    run('DELETE FROM chapters WHERE project_id = ?', p.id);
    run('DELETE FROM volumes WHERE project_id = ?', p.id);
    let i = 1;
    for (const v of arr.slice(0, 8)) {
      if (!v?.title) continue;
      run('INSERT INTO volumes (project_id, idx, title, summary, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        p.id, i++, String(v.title).slice(0, 80), String(v.summary || '').slice(0, 2000), t, t);
    }
    run('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', 'planned', t, p.id);
    res.json({
      volumes: all('SELECT * FROM volumes WHERE project_id = ? ORDER BY idx', p.id),
      mode: 'overwrite', deletedChapters: chapters.length,
    });
  } catch (e) {
    res.status(502).json({ error: e.message || '卷纲生成失败' });
  }
});

/* ============ 拆章与章节管理 ============ */

r.post('/:id/volumes/:vid/plan', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const vol = get('SELECT * FROM volumes WHERE id = ? AND project_id = ?', Number(req.params.vid), p.id);
  if (!vol) return res.status(404).json({ error: '卷不存在' });
  try {
    const existing = all('SELECT idx, title, brief FROM chapters WHERE project_id = ? ORDER BY idx', p.id);
    const entries = all('SELECT * FROM world_entries WHERE project_id = ?', p.id);
    const chars = all('SELECT * FROM characters WHERE project_id = ?', p.id);
    const n = p.type === 'short' ? 2 : 8;
    const { system, user } = P.chapterPlan(p, vol, existing, entries, chars, n);
    const out = await callAI({ task: 'planner', step: 'chapter_plan', system, user, projectId: p.id, mock: () => M.chapterPlan(p, vol, existing.length) });
    let arr = parseJSONLoose(out.text);
    if (!Array.isArray(arr) || !arr.length) arr = parseJSONArraySalvage(out.text);
    if (!Array.isArray(arr) || !arr.length) return res.status(502).json({ error: 'AI 返回的章节任务无法解析，请重试', raw: out.text.slice(0, 300) });
    const written = all("SELECT id, title, word_count FROM chapters WHERE project_id = ? AND volume_id = ? AND (word_count > 0 OR status <> 'planned')", p.id, vol.id);
    /* 重新拆章时只替换本卷尚未写正文的「待写」规划；草稿/完成与已写正文一律保留 */
    const replaced = get("SELECT COUNT(*) AS n FROM chapters WHERE project_id = ? AND volume_id = ? AND word_count = 0 AND status = 'planned'", p.id, vol.id).n;
    run("DELETE FROM chapters WHERE project_id = ? AND volume_id = ? AND word_count = 0 AND status = 'planned'", p.id, vol.id);
    const max = get('SELECT COALESCE(MAX(idx), 0) AS m FROM chapters WHERE project_id = ?', p.id).m;
    const t = now();
    let idx = max;
    let inserted = 0;
    const names = new Set(chars.map((c) => c.name));
    const writtenTitles = new Set(written.map((c) => c.title.trim()));
    for (const c of arr.slice(0, 20)) {
      if (!c?.title) continue;
      const title = String(c.title).slice(0, 60);
      if (writtenTitles.has(title.trim())) continue;
      idx++;
      inserted++;
      const cast = Array.isArray(c.cast) ? c.cast.map(String).filter((n2) => !names.size || names.has(n2)).slice(0, 6) : [];
      run(`INSERT INTO chapters (project_id, volume_id, idx, title, brief, scenes, cast_names, hook, status, content, word_count, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.id, vol.id, idx,
        title,
        String(c.brief || '').slice(0, 1000),
        String(c.scenes || '').slice(0, 1000),
        JSON.stringify(cast),
        String(c.hook || '').slice(0, 300),
        'planned', '', 0, t, t);
    }
    touch(p.id);
    res.json({ chapters: chapterList(p.id), replaced, planned: inserted, writtenChapters: written.filter((c) => c.word_count > 0).length });
  } catch (e) {
    res.status(502).json({ error: e.message || '拆章失败' });
  }
});

/* ============ 分卷新增 / 编辑 ============ */

const VOL_TITLE_MAX = 80;
const VOL_SUMMARY_MAX = 2000;

/** 卷字段校验：卷名必填且限长，简介限长；编辑时未传字段沿用原值 */
function normalizeVolume(body, base = {}) {
  const title = String(body.title ?? base.title ?? '').trim();
  const summary = String(body.summary ?? base.summary ?? '').trim();
  if (!title) return { error: '卷名不能为空' };
  if (title.length > VOL_TITLE_MAX) return { error: `卷名不能超过 ${VOL_TITLE_MAX} 个字` };
  if (summary.length > VOL_SUMMARY_MAX) return { error: `卷简介不能超过 ${VOL_SUMMARY_MAX} 个字` };
  return { title, summary };
}

function volumeDetail(p, v) {
  const chapters = all('SELECT id, idx, title, status, word_count FROM chapters WHERE volume_id = ? ORDER BY idx, id', v.id);
  return { ...v, chapters, chapterCount: chapters.length };
}

/* 本地单用户系统没有账号与角色权限体系，访问边界按作品归属校验：跨作品的卷一律视为不存在 */
r.get('/:id/volumes/:vid', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const v = get('SELECT * FROM volumes WHERE id = ? AND project_id = ?', Number(req.params.vid), p.id);
  if (!v) return res.status(404).json({ error: '卷不存在' });
  res.json(volumeDetail(p, v));
});

r.post('/:id/volumes', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const v = normalizeVolume(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  if (get('SELECT id FROM volumes WHERE project_id = ? AND title = ?', p.id, v.title)) {
    return res.status(400).json({ error: '已存在同名卷，请换一个卷名' });
  }
  const idx = get('SELECT COALESCE(MAX(idx), 0) AS m FROM volumes WHERE project_id = ?', p.id).m + 1;
  const t = now();
  const info = run('INSERT INTO volumes (project_id, idx, title, summary, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    p.id, idx, v.title, v.summary, t, t);
  touch(p.id);
  res.json({ ...volumeDetail(p, get('SELECT * FROM volumes WHERE id = ?', info.lastInsertRowid)), ok: true });
});

r.put('/:id/volumes/:vid', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const cur = get('SELECT * FROM volumes WHERE id = ? AND project_id = ?', Number(req.params.vid), p.id);
  if (!cur) return res.status(404).json({ error: '卷不存在' });
  const v = normalizeVolume(req.body || {}, cur);
  if (v.error) return res.status(400).json({ error: v.error });
  if (get('SELECT id FROM volumes WHERE project_id = ? AND title = ? AND id <> ?', p.id, v.title, cur.id)) {
    return res.status(400).json({ error: '已存在同名卷，请换一个卷名' });
  }
  run('UPDATE volumes SET title = ?, summary = ?, updated_at = ? WHERE id = ?', v.title, v.summary, now(), cur.id);
  touch(p.id);
  res.json({ ...volumeDetail(p, get('SELECT * FROM volumes WHERE id = ?', cur.id)), ok: true });
});

function chapterList(projectId) {
  return all(`SELECT id, volume_id, idx, title, brief, scenes, cast_names AS cast, hook, status, word_count, summary, review, created_at, updated_at
              FROM chapters WHERE project_id = ? ORDER BY idx, id`, projectId)
    .map((c) => ({ ...c, cast: parseField(c.cast, []), review: parseField(c.review, null) }));
}

r.get('/:id/chapters', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  res.json(chapterList(p.id));
});

r.post('/:id/chapters', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const { volumeId = null, title = '新章节', brief = '', scenes = '', cast = [], hook = '' } = req.body || {};
  const max = get('SELECT COALESCE(MAX(idx), 0) AS m FROM chapters WHERE project_id = ?', p.id).m;
  const t = now();
  const info = run(`INSERT INTO chapters (project_id, volume_id, idx, title, brief, scenes, cast_names, hook, status, content, word_count, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    p.id, volumeId ? Number(volumeId) : null, max + 1, String(title).slice(0, 60), brief, scenes,
    JSON.stringify(Array.isArray(cast) ? cast : []), hook, 'planned', '', 0, t, t);
  touch(p.id);
  res.json(get('SELECT * FROM chapters WHERE id = ?', info.lastInsertRowid));
});

r.get('/:id/chapters/:cid', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', Number(req.params.cid), p.id);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  res.json({ ...c, cast: parseField(c.cast_names, []), review: parseField(c.review, null) });
});

r.put('/:id/chapters/:cid', (req, res) => {
  const p = proj(req.params.id);
  const c = get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', Number(req.params.cid), p.id);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  const b = req.body || {};
  if (b.status !== undefined && !['planned', 'draft', 'done'].includes(b.status)) {
    return res.status(400).json({ error: '章节状态不合法' });
  }
  run('UPDATE chapters SET title = ?, brief = ?, scenes = ?, cast_names = ?, hook = ?, status = ?, volume_id = ?, updated_at = ? WHERE id = ?',
    b.title ?? c.title, b.brief ?? c.brief, b.scenes ?? c.scenes,
    b.cast !== undefined ? JSON.stringify(Array.isArray(b.cast) ? b.cast : []) : c.cast_names,
    b.hook ?? c.hook, b.status ?? c.status,
    b.volumeId !== undefined ? (b.volumeId ? Number(b.volumeId) : null) : c.volume_id,
    now(), c.id);
  touch(p.id);
  res.json({ ...get('SELECT * FROM chapters WHERE id = ?', c.id), cast: parseField(get('SELECT cast_names FROM chapters WHERE id = ?', c.id).cast_names, []) });
});

r.delete('/:id/chapters/:cid', (req, res) => {
  const p = proj(req.params.id);
  const c = get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', Number(req.params.cid), p.id);
  if (!c) return res.status(404).json({ error: '章节不存在' });
  run('DELETE FROM chapters WHERE id = ?', c.id);
  touch(p.id);
  res.json({ ok: true });
});

/* ============ 伏笔与线索 ============ */

const THREAD_KINDS = ['伏笔', '线索', '悬念', '承诺'];
const THREAD_STATUS = ['planted', 'reinforced', 'resolved', 'abandoned'];

r.get('/:id/threads', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  res.json(all('SELECT * FROM threads WHERE project_id = ? ORDER BY status, last_chapter DESC, id', p.id));
});

r.post('/:id/threads', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: '线索名不能为空' });
  const t = now();
  const info = run(`INSERT INTO threads (project_id, name, kind, status, detail, planted_chapter, last_chapter, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?)`,
    p.id, name.slice(0, 60),
    THREAD_KINDS.includes(b.kind) ? b.kind : '伏笔',
    THREAD_STATUS.includes(b.status) ? b.status : 'planted',
    String(b.detail || '').slice(0, 400),
    Number(b.plantedChapter) || null, Number(b.plantedChapter) || null, t, t);
  touch(p.id);
  res.json(get('SELECT * FROM threads WHERE id = ?', info.lastInsertRowid));
});

r.put('/:id/threads/:tid', (req, res) => {
  const row = get('SELECT * FROM threads WHERE id = ? AND project_id = ?', Number(req.params.tid), Number(req.params.id));
  if (!row) return res.status(404).json({ error: '线索不存在' });
  const b = req.body || {};
  run('UPDATE threads SET name = ?, kind = ?, status = ?, detail = ?, updated_at = ? WHERE id = ?',
    String(b.name || row.name).trim().slice(0, 60),
    THREAD_KINDS.includes(b.kind) ? b.kind : row.kind,
    THREAD_STATUS.includes(b.status) ? b.status : row.status,
    b.detail ?? row.detail,
    now(), row.id);
  res.json(get('SELECT * FROM threads WHERE id = ?', row.id));
});

r.delete('/:id/threads/:tid', (req, res) => {
  const row = get('SELECT * FROM threads WHERE id = ? AND project_id = ?', Number(req.params.tid), Number(req.params.id));
  if (!row) return res.status(404).json({ error: '线索不存在' });
  run('DELETE FROM threads WHERE id = ?', row.id);
  res.json({ ok: true });
});

/** 从某一章正文中提取伏笔线索（用于补录已有章节） */
r.post('/:id/threads/extract', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const cid = Number(req.body?.chapterId) || 0;
  const c = cid
    ? get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', cid, p.id)
    : get('SELECT * FROM chapters WHERE project_id = ? AND word_count > 0 ORDER BY idx DESC LIMIT 1', p.id);
  if (!c || !c.content?.trim()) return res.status(400).json({ error: '没有可分析的正文' });

  try {
    const existing = all('SELECT name FROM threads WHERE project_id = ?', p.id).map((x) => x.name);
    const { system, user } = P.extractThreads(c, existing);
    const out = await callAI({
      task: 'reviewer', step: 'thread_extract', system, user,
      projectId: p.id, chapterId: c.id,
      mock: () => M.extractThreads(c),
    });
    const arr = parseJSONLoose(out.text);
    if (!Array.isArray(arr)) return res.status(502).json({ error: 'AI 返回的线索无法解析，请重试' });
    const t = now();
    const existingSet = new Set(existing);
    let added = 0;
    for (const x of arr) {
      const name = String(x?.name || '').trim().slice(0, 60);
      if (!name || existingSet.has(name)) continue;
      run(`INSERT INTO threads (project_id, name, kind, status, detail, planted_chapter, last_chapter, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        p.id, name, THREAD_KINDS.includes(x.kind) ? x.kind : '伏笔', 'planted',
        String(x.detail || '').slice(0, 400), c.idx, c.idx, t, t);
      existingSet.add(name);
      added++;
    }
    res.json({ added, chapterIdx: c.idx, threads: all('SELECT * FROM threads WHERE project_id = ? ORDER BY id', p.id) });
  } catch (e) {
    res.status(502).json({ error: e.message || '线索提取失败' });
  }
});

export default r;
