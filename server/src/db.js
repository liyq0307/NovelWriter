import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from './env.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL DEFAULT '未命名作品',
  type         TEXT NOT NULL DEFAULT 'novel',   -- novel 长篇 | short 短篇
  status       TEXT NOT NULL DEFAULT 'idea',    -- idea -> direction -> building -> planned -> writing -> done
  premise      TEXT NOT NULL DEFAULT '',
  direction    TEXT,                            -- 选定方向 JSON
  contract     TEXT,                            -- 本书创作约定 JSON
  target_words INTEGER NOT NULL DEFAULT 0,
  sync_state   INTEGER NOT NULL DEFAULT 1,      -- 写后是否自动同步角色状态
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  category   TEXT NOT NULL DEFAULT '其他',      -- 地理/势力/规则/物品/历史/其他
  name       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'ai',        -- ai | human
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT '配角',      -- 主角/重要配角/配角/反派
  profile    TEXT NOT NULL DEFAULT '',
  goals      TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',          -- 当前状态（随正文同步）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,
  from_name   TEXT NOT NULL,
  to_name     TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT '关系',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS volumes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  idx        INTEGER NOT NULL DEFAULT 0,
  title      TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  volume_id  INTEGER,
  idx        INTEGER NOT NULL DEFAULT 0,        -- 全书章节序号
  title      TEXT NOT NULL DEFAULT '',
  brief      TEXT NOT NULL DEFAULT '',          -- 本章任务
  scenes     TEXT NOT NULL DEFAULT '',
  cast_names TEXT NOT NULL DEFAULT '[]',        -- 出场人物 JSON 数组
  hook       TEXT NOT NULL DEFAULT '',          -- 章末钩子
  status     TEXT NOT NULL DEFAULT 'planned',   -- planned | draft | done
  content    TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',          -- 本章摘要（写后由 AI 整理，作为后续章节的记忆）
  review     TEXT,                             -- 检查结果 JSON
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS style_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,                          -- NULL = 全局规则
  kind       TEXT NOT NULL DEFAULT 'style',    -- style 写法资产 | anti_ai 反AI规则
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ai_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER,
  chapter_id    INTEGER,
  step          TEXT NOT NULL,                 -- directions/world/characters/outline/chapter_plan/write/continue/rewrite/review/state_sync/test
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  estimated     INTEGER NOT NULL DEFAULT 0,    -- 1 = 厂商未返回用量，按字符估算
  status        TEXT NOT NULL DEFAULT 'ok',    -- ok | error
  error         TEXT,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

-- 章节历史快照：保存正文时留痕，可回滚
CREATE TABLE IF NOT EXISTS chapter_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  content    TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT 'autosave',  -- autosave | generate | batch | restore | manual
  created_at TEXT NOT NULL
);

-- 伏笔 / 线索追踪：写后由 AI 回流状态，也可人工维护
CREATE TABLE IF NOT EXISTS threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT '伏笔',   -- 伏笔 | 线索 | 悬念 | 承诺
  status          TEXT NOT NULL DEFAULT 'planted',-- planted 已埋 | reinforced 推进中 | resolved 已回收 | abandoned 已放弃
  detail          TEXT NOT NULL DEFAULT '',
  planted_chapter INTEGER,
  last_chapter    INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 每日写作字数（按项目），用于码字统计与连续写作天数
CREATE TABLE IF NOT EXISTS writing_log (
  project_id INTEGER NOT NULL,
  day        TEXT NOT NULL,
  words      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);

-- 批量连写任务（自动导演简版）：可暂停、恢复、取消
CREATE TABLE IF NOT EXISTS batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running', -- running | paused | done | error | cancelled
  from_idx      INTEGER NOT NULL,
  to_idx        INTEGER NOT NULL,
  cursor_idx    INTEGER NOT NULL DEFAULT 0,
  done_chapters INTEGER NOT NULL DEFAULT 0,
  words_added   INTEGER NOT NULL DEFAULT 0,
  review        INTEGER NOT NULL DEFAULT 1,
  sync          INTEGER NOT NULL DEFAULT 1,
  overwrite     INTEGER NOT NULL DEFAULT 0,
  message       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_world_project   ON world_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_chars_project   ON characters(project_id);
CREATE INDEX IF NOT EXISTS idx_vols_project    ON volumes(project_id);
CREATE INDEX IF NOT EXISTS idx_chapters_proj   ON chapters(project_id);
CREATE INDEX IF NOT EXISTS idx_calls_project   ON ai_calls(project_id);
CREATE INDEX IF NOT EXISTS idx_calls_chapter   ON ai_calls(chapter_id);
CREATE INDEX IF NOT EXISTS idx_rev_chapter     ON chapter_revisions(chapter_id);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(project_id);
CREATE INDEX IF NOT EXISTS idx_log_day         ON writing_log(day);
`);

export const now = () => new Date().toISOString();

export function all(sql, ...args) { return db.prepare(sql).all(...args); }
export function get(sql, ...args) { return db.prepare(sql).get(...args); }
export function run(sql, ...args) { return db.prepare(sql).run(...args); }

/** 轻量迁移：老库缺少新列时补上（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS） */
function ensureColumn(table, column, ddl) {
  const cols = all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('chapters', 'summary', "summary TEXT NOT NULL DEFAULT ''");

/** 解析 DB 里的 JSON 字段 */
export function parseField(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

/** 首次启动：写入默认全局规则 */
const ruleCount = get('SELECT COUNT(*) AS c FROM style_rules WHERE project_id IS NULL').c;
if (!ruleCount) {
  const defaults = [
    ['style', '展示而非告知', '优先用动作、对话与具体细节呈现信息，避免直接向读者解释设定或情绪；设定信息拆散到冲突中自然带出。'],
    ['style', '对话推进', '对话要携带信息差与立场冲突，不同人物语感区分；每场对话至少推进一个信息点或关系变化。'],
    ['anti_ai', '禁用陈词滥调', '禁止使用「嘴角勾起一抹弧度」「眸中闪过一丝精光」「空气仿佛凝固」「心脏漏跳一拍」等高频 AI 腔表达。'],
    ['anti_ai', '句式长短错落', '连续三句以上等长句必须打破节奏；避免排比堆叠，避免滥用「不是……而是……」「仿佛」「宛如」句式。'],
    ['anti_ai', '少解释多留白', '删除重复渲染情绪的句子，同一情绪只在动作或细节中呈现一次；结尾不总结不升华。'],
  ];
  for (const [kind, name, content] of defaults) {
    run('INSERT INTO style_rules (project_id, kind, name, content, enabled) VALUES (NULL, ?, ?, ?, 1)', kind, name, content);
  }
}
