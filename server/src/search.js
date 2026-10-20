/**
 * 全文检索：把世界设定 / 角色 / 章节摘要 / 事实 / 伏笔写进索引，
 * 供写作上下文召回与手动检索使用。
 * 优先使用 SQLite FTS5（trigram，适合中文）；不可用时自动降级为 LIKE。
 */
import { all, get, run, db } from './db.js';
import { clip } from './util.js';

let ftsReady = null;

/** FTS5 + trigram 是否可用（首次调用时探测） */
function hasFTS() {
  if (ftsReady !== null) return ftsReady;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      project_id UNINDEXED, kind UNINDEXED, ref_id UNINDEXED, title, body, tokenize='trigram'
    )`);
    // 触发器一次写入以确认 trigram 分词器真的可用
    run("INSERT INTO search_fts (project_id, kind, ref_id, title, body) VALUES (0, '_probe', 0, 'probe', 'probe')");
    run("DELETE FROM search_fts WHERE kind = '_probe'");
    ftsReady = true;
  } catch {
    ftsReady = false;
  }
  return ftsReady;
}

/** 源数据签名：结构性变化或任意条目更新时重建索引 */
function sourceSignature(projectId) {
  const row = get(
    `SELECT
       (SELECT COUNT(*) FROM world_entries WHERE project_id = ?) AS wc,
       (SELECT COALESCE(MAX(updated_at), '') FROM world_entries WHERE project_id = ?) AS wu,
       (SELECT COUNT(*) FROM characters WHERE project_id = ?) AS cc,
       (SELECT COALESCE(MAX(updated_at), '') FROM characters WHERE project_id = ?) AS cu,
       (SELECT COUNT(*) FROM chapters WHERE project_id = ? AND word_count > 0) AS hc,
       (SELECT COALESCE(SUM(LENGTH(title) + LENGTH(brief) + LENGTH(summary)), 0)
          FROM chapters WHERE project_id = ? AND word_count > 0) AS hs,
       (SELECT COALESCE(MAX(updated_at), '') FROM facts WHERE project_id = ?) AS fu,
       (SELECT COUNT(*) FROM threads WHERE project_id = ?) AS tc,
       (SELECT COALESCE(MAX(updated_at), '') FROM threads WHERE project_id = ?) AS tu`,
    projectId, projectId, projectId, projectId, projectId, projectId,
    projectId, projectId, projectId
  );
  return Object.values(row || {}).join('|');
}

function docsOf(projectId) {
  const docs = [];
  for (const w of all('SELECT * FROM world_entries WHERE project_id = ?', projectId)) {
    docs.push({ kind: 'world', ref_id: w.id, title: `${w.category}·${w.name}`, body: `${w.name} ${w.content}` });
  }
  for (const c of all('SELECT * FROM characters WHERE project_id = ?', projectId)) {
    docs.push({ kind: 'character', ref_id: c.id, title: c.name, body: `${c.role} ${c.profile} ${c.goals} ${c.status}` });
  }
  for (const c of all('SELECT * FROM chapters WHERE project_id = ? AND word_count > 0', projectId)) {
    if (!c.summary && !c.brief) continue;
    docs.push({
      kind: 'chapter',
      ref_id: c.id,
      title: `第${c.idx}章 ${c.title}`,
      body: `${c.summary || ''} ${c.brief || ''} ${clip(c.content, 600)}`,
    });
  }
  for (const f of all("SELECT * FROM facts WHERE project_id = ? AND status = 'active'", projectId)) {
    docs.push({ kind: 'fact', ref_id: f.id, title: `${f.kind}${f.subject ? '·' + f.subject : ''}`, body: f.fact });
  }
  for (const t of all('SELECT * FROM threads WHERE project_id = ?', projectId)) {
    docs.push({ kind: 'thread', ref_id: t.id, title: t.name, body: `${t.kind} ${t.detail}` });
  }
  return docs;
}

/** 重建某本书的索引（仅在源数据变化时执行） */
export function ensureIndex(projectId) {
  const pid = Number(projectId);
  const sigKey = `search_sig:${pid}`;
  const sig = sourceSignature(pid);
  const saved = get('SELECT value FROM settings WHERE key = ?', sigKey)?.value;
  if (saved === sig) return;
  const docs = docsOf(pid);
  run('DELETE FROM search_docs WHERE project_id = ?', pid);
  for (const d of docs) {
    run('INSERT INTO search_docs (project_id, kind, ref_id, title, body) VALUES (?,?,?,?,?)',
      pid, d.kind, d.ref_id, String(d.title).slice(0, 120), String(d.body).slice(0, 3000));
  }
  if (hasFTS()) {
    run('DELETE FROM search_fts WHERE project_id = ?', pid);
    for (const d of docs) {
      run('INSERT INTO search_fts (project_id, kind, ref_id, title, body) VALUES (?,?,?,?,?)',
        pid, d.kind, d.ref_id, String(d.title).slice(0, 120), String(d.body).slice(0, 3000));
    }
  }
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', sigKey, sig);
}

function snippet(body, q) {
  const s = String(body || '').replace(/\s+/g, ' ').trim();
  const i = q ? s.indexOf(q) : -1;
  if (i < 0) return clip(s, 120);
  const start = Math.max(0, i - 40);
  return (start > 0 ? '…' : '') + s.slice(start, start + 140) + (start + 140 < s.length ? '…' : '');
}

const KIND_ORDER = { character: 0, world: 1, fact: 2, chapter: 3, thread: 4 };

/** 单次检索（假定索引已就绪）：返回 [{kind, refId, title, snippet}] */
function queryIndex(pid, q, limit) {
  let rows = [];
  if (hasFTS() && q.length >= 3) {
    try {
      rows = all(
        `SELECT kind, ref_id, title, body FROM search_fts
         WHERE search_fts MATCH ? AND project_id = ?
         ORDER BY rank LIMIT ?`,
        `"${q.replace(/"/g, '""')}"`, pid, limit
      );
    } catch {
      rows = [];
    }
  }
  if (!rows.length) {
    const like = `%${q}%`;
    rows = all(
      `SELECT kind, ref_id, title, body FROM search_docs
       WHERE project_id = ? AND (title LIKE ? OR body LIKE ?)
       ORDER BY id LIMIT ?`,
      pid, like, like, limit
    );
  }
  return rows
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
    .map((r) => ({ kind: r.kind, refId: r.ref_id, title: r.title, snippet: snippet(r.body, q) }));
}

/** 手动检索入口：先确保索引是新的 */
export function searchProject(projectId, query, limit = 12) {
  const pid = Number(projectId);
  const q = String(query || '').trim();
  if (!pid || !q) return [];
  ensureIndex(pid);
  return queryIndex(pid, q, limit);
}

/** 删除某本书的索引与签名（删项目时调用，避免孤儿数据） */
export function dropProjectIndex(projectId) {
  const pid = Number(projectId);
  run('DELETE FROM search_docs WHERE project_id = ?', pid);
  if (hasFTS()) {
    try {
      run('DELETE FROM search_fts WHERE project_id = ?', pid);
    } catch {
      // FTS 表异常时不影响项目删除
    }
  }
  run('DELETE FROM settings WHERE key = ?', `search_sig:${pid}`);
}

/** 从一段文本里抽关键词（中英文混合，2-6 字片段） */
function keywordsOf(text, max = 16) {
  const segs = String(text || '').split(/[^\u4e00-\u9fa5A-Za-z0-9]+/).filter((s) => s.length >= 2);
  const out = [];
  for (const s of segs) {
    if (s.length <= 6) { if (!out.includes(s)) out.push(s); continue; }
    for (let i = 0; i + 3 <= s.length; i += 2) {
      const piece = s.slice(i, i + 3);
      if (!out.includes(piece)) out.push(piece);
    }
  }
  return out.slice(0, max);
}

/**
 * 上下文召回：用章节任务文本检索相关资料。
 * 命中按 (kind, refId) 去重，最多 limit 条。
 */
export function recall(projectId, text, limit = 6) {
  const pid = Number(projectId);
  if (!pid) return [];
  ensureIndex(pid); // 一次召回只校验一次索引，避免每个关键词都查一遍签名
  const out = [];
  const seen = new Set();
  for (const kw of keywordsOf(text)) {
    for (const hit of queryIndex(pid, kw, 4)) {
      const key = `${hit.kind}:${hit.refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
