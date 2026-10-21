/**
 * 创作管线：写作路由与批量连写共用的服务层。
 * - chapterContext：组装本章上下文（稳定资料前置，动态资料后置）
 * - postWriteSync：写后整理（章节摘要 + 角色状态 + 伏笔线索），一次调用三件事
 * - reviewChapter：章节质检并落库
 * - snapshotChapter：正文版本快照（可回溯 / 回滚）
 * - saveChapterContent：保存正文、更新进度、记录写作字数
 */
import { all, get, run, now } from './db.js';
import { callAI } from './ai.js';
import * as P from './prompts.js';
import * as M from './mock.js';
import { parseJSONLoose, countWords } from './util.js';
import { getFlavorConfig } from './flavor.js';
import { recall } from './search.js';

const chapter = (pid, cid) => get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', Number(cid), Number(pid));
const touch = (id) => run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), id);

/* ============ 上下文 ============ */

const WORLD_MAX = 12;
const WORLD_BUDGET = 1800;
const CHARS_MAX = 8;

/** 从本章任务中抽取用于相关度匹配的词：出场人名 + 任务文本的二字片段 */
function worldTokens(c) {
  const tokens = new Set((c.cast || []).filter((n) => n && n.length >= 2));
  const segs = `${c.title || ''} ${c.brief || ''} ${c.scenes || ''} ${c.hook || ''}`
    .split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)
    .filter((s) => s.length >= 2);
  for (const s of segs) {
    if (s.length <= 4) {
      tokens.add(s);
      continue;
    }
    for (let i = 0; i + 2 <= s.length; i++) tokens.add(s.slice(i, i + 2));
  }
  return [...tokens];
}

/**
 * 按本章任务筛选世界条目：先按相关度打分，再按字符预算截断。
 * 条目不多时原样返回，避免破坏小项目的完整设定。
 */
export function selectWorld(entries, c) {
  if (entries.length <= WORLD_MAX) return entries;
  const tokens = worldTokens(c);
  const scored = entries.map((w, i) => {
    const hay = `${w.name || ''}${w.category || ''}${w.content || ''}`;
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 2;
    return { w, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const { w, score } of scored) {
    if (picked.length >= WORLD_MAX) break;
    // 没有任何相关命中时最多兜底 6 条，避免把无关设定灌进上下文
    if (!score && picked.length >= 6) break;
    const cost = Math.min(String(w.content || '').length, 120) + 24;
    if (picked.length >= 4 && used + cost > WORLD_BUDGET) break;
    picked.push(w);
    used += cost;
  }
  return picked;
}

/** 组装本章上下文：世界规则、出场人物、写法规则、前情摘要、伏笔、上一章结尾 */
export function chapterContext(p, c) {
  const worldAll = all('SELECT * FROM world_entries WHERE project_id = ?', p.id);
  const chars = all('SELECT * FROM characters WHERE project_id = ?', p.id);
  const castSet = new Set(c.cast || []);
  let useChars = chars.filter((ch) => castSet.has(ch.name));
  if (!useChars.length) useChars = chars.filter((ch) => ch.role === '主角' || ch.role === '反派');
  if (!useChars.length) useChars = chars.slice(0, 4);
  if (useChars.length > CHARS_MAX) useChars = useChars.slice(0, CHARS_MAX);
  const world = selectWorld(worldAll, c);
  const flavor = getFlavorConfig();
  const flavorWords = flavor.wordEnabled
    ? flavor.rules.filter((r) => r.enabled !== false).slice(0, 24)
    : [];
  const rules = all(
    'SELECT * FROM style_rules WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY project_id DESC, id',
    p.id
  );
  const prev = get(
    'SELECT title, content FROM chapters WHERE project_id = ? AND word_count > 0 AND idx < ? ORDER BY idx DESC LIMIT 1',
    p.id, c.idx
  );
  const summaries = all(
    `SELECT idx, title, summary FROM chapters
     WHERE project_id = ? AND idx < ? AND word_count > 0 AND summary <> ''
     ORDER BY idx DESC LIMIT 6`,
    p.id, c.idx
  ).reverse();
  const threads = all(
    `SELECT * FROM threads WHERE project_id = ? AND status IN ('planted', 'reinforced')
     ORDER BY last_chapter DESC, id LIMIT 20`,
    p.id
  );
  const facts = all(
    "SELECT * FROM facts WHERE project_id = ? AND status = 'active' ORDER BY id DESC LIMIT 30",
    p.id
  ).reverse();
  /* 全文检索召回：按本章任务匹配世界 / 角色 / 摘要 / 事实，补充上下文 */
  let recalls = [];
  try {
    recalls = recall(p.id, `${c.title || ''} ${c.brief || ''} ${c.scenes || ''}`, 5);
  } catch { /* 检索不可用时不影响写作 */ }
  return {
    world, useChars, rules, summaries, threads, flavorWords, facts, recalls,
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

export function mockCtx(c, ctx) {
  const names = c.cast?.length ? c.cast : ctx.useChars.map((ch) => ch.name);
  const place = ctx.world.find((w) => w.category === '地理')?.name || '临渊城';
  const item = ctx.world.find((w) => w.category === '物品')?.name || '罗盘';
  return { castNames: names.length ? names : ['林渡'], place, item, otherName: ctx.useChars[1]?.name };
}

/* ============ 伏笔线索 ============ */

const THREAD_KINDS = ['伏笔', '线索', '悬念', '承诺'];
const THREAD_ACTIONS = ['new', 'advance', 'resolve', 'drop'];

/** 把 AI 返回的线索事件写回线索库 */
export function applyThreadEvents(projectId, chapterIdx, events) {
  let changed = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e?.name) continue;
    const name = String(e.name).trim().slice(0, 60);
    if (!name) continue;
    const action = THREAD_ACTIONS.includes(e.action) ? e.action : 'advance';
    const kind = THREAD_KINDS.includes(e.kind) ? e.kind : '伏笔';
    const detail = String(e.detail || '').slice(0, 400);
    const row = get('SELECT * FROM threads WHERE project_id = ? AND name = ?', projectId, name);
    const t = now();
    if (!row) {
      const status = action === 'resolve' ? 'resolved' : action === 'drop' ? 'abandoned' : 'planted';
      run(`INSERT INTO threads (project_id, name, kind, status, detail, planted_chapter, last_chapter, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        projectId, name, kind, status, detail, chapterIdx, chapterIdx, t, t);
      changed++;
      continue;
    }
    const status = action === 'resolve' ? 'resolved' : action === 'drop' ? 'abandoned' : 'reinforced';
    run('UPDATE threads SET status = ?, detail = ?, last_chapter = ?, updated_at = ? WHERE id = ?',
      status, detail || row.detail, chapterIdx, t, row.id);
    changed++;
  }
  return changed;
}

/* ============ 写后整理 ============ */

const FACT_KINDS = ['世界规则', '时间线', '人物', '剧情'];

/** 把写后抽取的既定事实入库，按正文去重 */
export function applyFacts(projectId, chapterIdx, items) {
  let changed = 0;
  for (const f of Array.isArray(items) ? items : []) {
    const fact = String(f?.fact || '').trim().slice(0, 300);
    if (!fact) continue;
    if (get('SELECT id FROM facts WHERE project_id = ? AND fact = ?', projectId, fact)) continue;
    const kind = FACT_KINDS.includes(f.kind) ? f.kind : '剧情';
    const subject = String(f.subject || '').trim().slice(0, 60);
    const t = now();
    run(`INSERT INTO facts (project_id, kind, subject, fact, chapter_idx, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      projectId, kind, subject, fact, chapterIdx, 'active', t, t);
    changed++;
  }
  return changed;
}

/**
 * 写后整理：生成章节摘要、同步角色状态、回流伏笔线索、沉淀既定事实。
 * 返回 { updated, summary, threads, facts }
 */
export async function postWriteSync(p, c) {
  const chars = all('SELECT * FROM characters WHERE project_id = ?', p.id);
  const threads = all("SELECT * FROM threads WHERE project_id = ? AND status IN ('planted','reinforced')", p.id);
  const facts = all("SELECT fact FROM facts WHERE project_id = ? AND status = 'active' ORDER BY id DESC LIMIT 40", p.id);
  const { system, user } = P.postWrite(p, c, chars, threads, facts);
  const out = await callAI({
    task: 'reviewer', step: 'post_write', system, user,
    projectId: p.id, chapterId: c.id,
    mock: () => M.postWrite(p, c, chars, threads),
  });
  const obj = parseJSONLoose(out.text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('AI 返回的写后整理结果无法解析，请重试');
  }

  const summary = String(obj.summary || '').trim().slice(0, 800);
  if (summary) {
    run('UPDATE chapters SET summary = ?, updated_at = ? WHERE id = ?', summary, now(), c.id);
  }

  const updated = [];
  for (const u of Array.isArray(obj.characters) ? obj.characters : []) {
    if (!u?.name || !u?.status) continue;
    const info = run('UPDATE characters SET status = ?, updated_at = ? WHERE project_id = ? AND name = ?',
      String(u.status).slice(0, 400), now(), p.id, String(u.name));
    if (info.changes > 0) updated.push({ name: u.name, status: u.status });
  }

  const threadCount = applyThreadEvents(p.id, c.idx, obj.threads);
  const factsCount = applyFacts(p.id, c.idx, obj.facts);
  return { updated, summary, threads: threadCount, facts: factsCount };
}

/* ============ 章节检查 ============ */

/** 章节质检：调用审阅模型、规范化结果并落库 */
export async function reviewChapter(p, c) {
  const ctx = chapterContext(p, c);
  const { system, user } = P.review(p, c, ctx);
  const out = await callAI({
    task: 'reviewer', step: 'review', system, user,
    projectId: p.id, chapterId: c.id,
    mock: () => M.review(c),
  });
  const rv = parseJSONLoose(out.text);
  if (!rv || typeof rv.score !== 'number') {
    const err = new Error('AI 返回的检查结果无法解析，请重试');
    err.raw = String(out.text || '').slice(0, 300);
    throw err;
  }
  const normalized = {
    score: Math.max(0, Math.min(100, Math.round(rv.score))),
    summary: String(rv.summary || ''),
    issues: Array.isArray(rv.issues)
      ? rv.issues.filter((i) => i?.problem).map((i) => ({
          severity: ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium',
          type: String(i.type || '其他'),
          location: String(i.location || ''),
          problem: String(i.problem || ''),
          suggestion: String(i.suggestion || ''),
        }))
      : [],
  };
  run('UPDATE chapters SET review = ?, updated_at = ? WHERE id = ?', JSON.stringify(normalized), now(), c.id);
  touch(p.id);
  return normalized;
}

/* ============ 章节修文（检查闭环） ============ */

/** 依据检查问题重写整章：失败或字数异常时抛错，由调用方保留原稿 */
export async function reviseChapter(p, c, review, ctx = {}) {
  const { system, user } = P.revise(p, c, review, ctx);
  const out = await callAI({
    task: 'writer', step: 'revise', system, user,
    projectId: p.id, chapterId: c.id,
    mock: () => c.content || '',
  });
  const text = String(out.text || '').trim();
  if (!text) throw new Error('修文模型没有返回正文');
  if (String(c.content || '').trim() && countWords(text) < countWords(c.content) * 0.7) {
    throw new Error('修文结果字数异常，已保留原稿');
  }
  return text;
}

/* ============ 版本快照 ============ */

const REVISION_LIMIT = 80;

/**
 * 保存一条正文快照。
 * 自动保存默认 60 秒内合并，避免防抖保存制造大量无意义版本；
 * 生成 / 批量 / 修文 / 回滚等关键节点用 force=true 强制留痕。
 */
export function snapshotChapter(projectId, chapterId, content, wc, reason = 'autosave', force = false) {
  const last = get('SELECT * FROM chapter_revisions WHERE chapter_id = ? ORDER BY id DESC LIMIT 1', chapterId);
  if (!force) {
    if (last && last.content === content) return null;
    if (last && Date.now() - Date.parse(last.created_at) < 60_000) return null;
  }
  run('INSERT INTO chapter_revisions (project_id, chapter_id, content, word_count, reason, created_at) VALUES (?,?,?,?,?,?)',
    projectId, chapterId, content, wc, reason, now());
  const extra = (get('SELECT COUNT(*) AS n FROM chapter_revisions WHERE chapter_id = ?', chapterId).n || 0) - REVISION_LIMIT;
  if (extra > 0) {
    run(`DELETE FROM chapter_revisions WHERE id IN (
           SELECT id FROM chapter_revisions WHERE chapter_id = ? ORDER BY id ASC LIMIT ?
         )`, chapterId, extra);
  }
  return true;
}

/* ============ 写作统计 ============ */

function dayKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function recordWords(projectId, delta) {
  if (!projectId || !delta || delta <= 0) return;
  run(`INSERT INTO writing_log (project_id, day, words) VALUES (?, ?, ?)
       ON CONFLICT(project_id, day) DO UPDATE SET words = words + excluded.words`,
    projectId, dayKey(), Math.round(delta));
}

/* ============ 保存正文 ============ */

/**
 * 保存一章正文，并处理：字数、状态、项目进度、版本快照、写作统计、（可选）写后整理。
 * opts: { reason, sync, forceSnapshot }
 */
export async function saveChapterContent(p, c, content, opts = {}) {
  const reason = opts.reason || 'autosave';
  const text = String(content ?? '');
  const oldWc = Number(c.word_count) || 0;
  const wc = countWords(text);
  const newStatus = wc > 0 && c.status === 'planned' ? 'draft' : c.status;

  run('UPDATE chapters SET content = ?, word_count = ?, status = ?, updated_at = ? WHERE id = ?',
    text, wc, newStatus, now(), c.id);

  /* 正文被生成 / 批量 / 回滚 / 修文改动后，旧的检查结论已失效，避免 UI 继续展示旧评分 */
  if (['generate', 'batch', 'restore', 'revise', 'clear'].includes(reason)) {
    run('UPDATE chapters SET review = NULL WHERE id = ?', c.id);
  }

  if (wc > 0) {
    run(`UPDATE projects SET status = 'writing', updated_at = ?
         WHERE id = ? AND status IN ('direction', 'building', 'planned', 'writing')`, now(), p.id);
  } else {
    touch(p.id);
  }

  if (text.trim()) snapshotChapter(p.id, c.id, text, wc, reason, !!opts.forceSnapshot);
  recordWords(p.id, wc - oldWc);

  let synced = null;
  let summary = null;
  let threads = 0;
  let syncError = null;
  if (opts.sync && p.sync_state && wc > 0) {
    try {
      const fresh = chapter(p.id, c.id);
      const r = await postWriteSync(p, fresh);
      synced = r.updated;
      summary = r.summary;
      threads = r.threads;
    } catch (e) {
      syncError = e?.message || String(e);
    }
  }

  return { ok: true, wordCount: wc, status: newStatus, synced, summary, threads, syncError };
}
