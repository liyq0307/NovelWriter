/**
 * 去AI味引擎（三层检测，对齐 BYWD-天宫 的实现）：
 * 1. 词表层：默认 30 条 AI 腔高频词，可逐条启停；
 * 2. 统计层：平均句长、句首复读、五官/心理套话模板；
 * 3. 模型层：可选让模型给 0-100 的 AI 腔评分与一句改进建议。
 * 计分：min(30, 词表命中数 × 2) + 统计分（上限 50），总分 0-100；
 * 达到警告阈值提示润色，达到拦截阈值判定需改写。模型分只做参考，不计入总分。
 */
import { get, run } from './db.js';
import { callAI } from './ai.js';
import { extractJSON } from './util.js';

const SETTINGS_KEY = 'flavor';

export const DEFAULT_FLAVOR_SETTINGS = {
  wordEnabled: true,
  statEnabled: true,
  modelEnabled: false,
  warnThreshold: 40,
  blockThreshold: 70,
};

/** 默认词表：[词, 原因, 建议] */
const DEFAULT_WORDS = [
  ['仿佛', '高频虚化词，削弱现场感', '改为具体感官或删去'],
  ['宛如', '同「仿佛」，AI 高频词', '改用准确比喻或直接描写'],
  ['似乎', '猜测式虚词，削弱笃定', '给出确切动作/事实'],
  ['眼底闪过一丝', 'AI 招牌五官描写', '写具体动作或心理'],
  ['眼神中', '脸谱化表情套路', '用行为表现情绪'],
  ['不由得', 'AI 高频连接词', '删去或改用节奏'],
  ['默默', '笼统副词', '写实际动作'],
  ['静静地', 'AI 高频叠词', '删去'],
  ['隐隐', '虚化词', '删去或写实'],
  ['微微', 'AI 高频程度词', '删去或换更强动词'],
  ['缓缓', '流速副词滥用', '删去'],
  ['这便是', '总结式 AI 腔', '改为展示而非陈述'],
  ['无法形容', '形容词偷懒', '写具体感受'],
  ['难以言喻', '同上', '写具体细节'],
  ['与此同时', 'AI 高频转场词', '重写转场'],
  ['然而此刻', 'AI 高频转折', '精简'],
  ['在这瞬间', 'AI 高频瞬间词', '删去'],
  ['一股……的气息', 'AI 万能描述模板', '写具体五感'],
  ['莫名地', 'AI 高频虚词', '删去'],
  ['内心深处', 'AI 高频洞悉词', '改为行动'],
  ['此刻他的心中', '直白心理陈述', '克制传情，用细节'],
  ['仿佛整个……', '宏大虚写', '写具体'],
  ['能看出', '观察解释化', '改为动作'],
  ['他们都知道', '旁白上帝视角', '改为视点内'],
  ['一个……的传说', 'AI 背景介绍模板', '融入情节'],
  ['那道身影', 'AI 高频代称', '用名字或动作'],
  ['目光变得深邃', 'AI 五官套路', '写具体行为'],
  ['嘴角勾起一抹', 'AI 表情套路', '写动作'],
  ['空气仿佛凝固', 'AI 氛围模板', '写具体反应'],
  ['没有人注意到', 'AI 转折铺垫', '写具体'],
];

export function buildDefaultRules() {
  return DEFAULT_WORDS.map(([phrase, reason, suggestion], i) => ({
    id: `flv_${String(i + 1).padStart(3, '0')}`,
    phrase,
    reason: `命中 AI 腔词「${phrase}」：${reason}`,
    suggestion,
    enabled: true,
  }));
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 读取配置：默认值 + 已保存设置，词表按 phrase 合并（保留用户启停状态，新增默认词自动补齐） */
export function getFlavorConfig() {
  let saved = null;
  const row = get('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY);
  if (row) {
    try { saved = JSON.parse(row.value); } catch { saved = null; }
  }
  const cfg = {
    ...DEFAULT_FLAVOR_SETTINGS,
    wordEnabled: saved?.wordEnabled !== false,
    statEnabled: saved?.statEnabled !== false,
    modelEnabled: saved?.modelEnabled === true,
    warnThreshold: Number.isFinite(Number(saved?.warnThreshold)) ? clampThreshold(saved.warnThreshold) : DEFAULT_FLAVOR_SETTINGS.warnThreshold,
    blockThreshold: Number.isFinite(Number(saved?.blockThreshold)) ? clampThreshold(saved.blockThreshold) : DEFAULT_FLAVOR_SETTINGS.blockThreshold,
  };
  const savedRules = Array.isArray(saved?.rules) ? saved.rules : [];
  const byPhrase = new Map(savedRules.map((r) => [String(r?.phrase || ''), r]));
  const rules = [];
  for (const d of buildDefaultRules()) {
    const s = byPhrase.get(d.phrase);
    rules.push(s ? { ...d, enabled: s.enabled !== false } : d);
  }
  for (const s of savedRules) {
    if (!s?.phrase || rules.some((r) => r.phrase === s.phrase)) continue;
    rules.push({ id: s.id || `flv_x${rules.length}`, phrase: String(s.phrase), reason: String(s.reason || ''), suggestion: String(s.suggestion || ''), enabled: s.enabled !== false });
  }
  return { ...cfg, rules };
}

function clampThreshold(v) {
  return Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
}

export function saveFlavorConfig(input = {}) {
  const prev = getFlavorConfig();
  const next = {
    wordEnabled: input.wordEnabled === undefined ? prev.wordEnabled : !!input.wordEnabled,
    statEnabled: input.statEnabled === undefined ? prev.statEnabled : !!input.statEnabled,
    modelEnabled: input.modelEnabled === undefined ? prev.modelEnabled : !!input.modelEnabled,
    warnThreshold: input.warnThreshold === undefined ? prev.warnThreshold : clampThreshold(input.warnThreshold),
    blockThreshold: input.blockThreshold === undefined ? prev.blockThreshold : clampThreshold(input.blockThreshold),
    rules: Array.isArray(input.rules)
      ? input.rules
        .filter((r) => r && String(r.phrase || '').trim())
        .slice(0, 300)
        .map((r, i) => ({
          id: r.id || `flv_c${i + 1}`,
          phrase: String(r.phrase).trim().slice(0, 40),
          reason: String(r.reason || `命中 AI 腔词「${String(r.phrase).trim()}」`).slice(0, 200),
          suggestion: String(r.suggestion || '改写或删去').slice(0, 200),
          enabled: r.enabled !== false,
        }))
      : prev.rules,
  };
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    SETTINGS_KEY, JSON.stringify(next)
  );
  return next;
}

/** 词表层：逐条正则扫描，按出现位置排序，最多返回 60 条 */
export function scanWordHits(text, rules) {
  const out = [];
  for (const rule of rules || []) {
    if (rule.enabled === false) continue;
    const re = new RegExp(escapeRegExp(rule.phrase), 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({
        id: `flv_${rule.id || out.length}_${m.index}`,
        type: 'word',
        phrase: m[0],
        reason: rule.reason,
        suggestion: rule.suggestion,
        severity: 'warn',
        index: m.index,
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out.sort((a, b) => a.index - b.index).slice(0, 60);
}

/** 统计层：平均句长、句首复读、五官/心理套话，返回 { hits, score } */
export function scanStatHits(text) {
  const hits = [];
  const sentences = String(text || '')
    .split(/[。！？!?…]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let score = 0;

  if (sentences.length >= 5) {
    const lens = sentences.map((s) => s.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (avg > 55) {
      score += 20;
      hits.push({
        id: 'flv_avg', type: 'stat', phrase: '平均句长过长',
        reason: `均值 ${avg.toFixed(0)} 字/句，AI 倾向长句堆叠`,
        suggestion: '拆短句、加对话与动作切分节奏',
        severity: 'warn', index: 0,
      });
    }
    const heads = new Map();
    for (const s of sentences) {
      const c = s[0];
      if (c) heads.set(c, (heads.get(c) || 0) + 1);
    }
    for (const [c, n] of heads) {
      if (n >= 3) {
        score += 5;
        hits.push({
          id: `flv_head_${c}`, type: 'stat', phrase: `句首复读「${c}」×${n}`,
          reason: '句首单字高频复读，行文机械',
          suggestion: '变化句首（主语/状语/直接出动作）',
          severity: 'warn', index: 0,
        });
      }
    }
  }

  const sensory = (String(text || '').match(/脸色|眼神|嘴角|心里|脑海|目光/g) || []).length;
  if (sensory > 6) {
    score += 10;
    hits.push({
      id: 'flv_sensory', type: 'stat', phrase: `五官/心理套话 ×${sensory}`,
      reason: '高频使用「脸色/眼神/嘴角 + 动作」模板',
      suggestion: '换成纯动作或对话推进',
      severity: 'warn', index: 0,
    });
  }

  return { hits, score: Math.min(50, score) };
}

/** 模型层：让模型打 AI 腔分并给一条建议；失败时静默返回 null */
async function scanByModel(text, ctx = {}) {
  const system = '你是网文编辑，专门识别 AI 生成的腔调。只输出 JSON，不要任何解释。';
  const user = `给下面这段网文正文的"AI 腔"程度打 0-100 分（越高越像 AI 写的），并给一句最关键的改进建议。只输出 JSON：{"score":0,"note":""}。正文：\n${String(text).slice(0, 3000)}`;
  try {
    const out = await callAI({
      task: 'reviewer', step: 'flavor', system, user,
      projectId: ctx.projectId, chapterId: ctx.chapterId,
      temperature: 0,
      mock: () => JSON.stringify({ score: 0, note: '（Mock 模式）模型评分层已启用，但未连接真实模型。' }),
    });
    const json = extractJSON(out.text);
    const parsed = json ? JSON.parse(json) : null;
    const score = Math.round(Number(parsed?.score));
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.max(0, Math.min(100, score)),
      note: typeof parsed?.note === 'string' ? parsed.note : '',
    };
  } catch {
    return null;
  }
}

/** 汇总扫描：返回分数、等级、词表/统计命中与模型建议 */
export async function scanFlavor(text, ctx = {}) {
  const cfg = ctx.config || getFlavorConfig();
  const wordHits = cfg.wordEnabled ? scanWordHits(text, cfg.rules) : [];
  const stat = cfg.statEnabled ? scanStatHits(text) : { hits: [], score: 0 };
  let modelNote = '';
  let modelScore = null;

  if (cfg.modelEnabled && String(text || '').trim()) {
    const m = await scanByModel(text, ctx);
    if (m) { modelScore = m.score; modelNote = m.note; }
  }

  const wordScore = Math.min(30, wordHits.length * 2);
  const score = Math.max(0, Math.min(100, wordScore + stat.score));
  const level = score >= cfg.blockThreshold ? 'block' : score >= cfg.warnThreshold ? 'warn' : 'ok';
  const levelText = level === 'block' ? '需改写' : level === 'warn' ? '建议润色' : '尚可';
  const summary = `AI 腔指数 ${score}（${levelText}）。词表命中 ${wordHits.length}，统计问题 ${stat.hits.length}。${modelNote}`.trim();

  return {
    score, level, levelText, summary,
    wordHits, statHits: stat.hits,
    modelScore, modelNote,
    thresholds: { warn: cfg.warnThreshold, block: cfg.blockThreshold },
    stats: {
      words: String(text || '').replace(/\s/g, '').length,
      wordScore,
      statScore: stat.score,
    },
  };
}
