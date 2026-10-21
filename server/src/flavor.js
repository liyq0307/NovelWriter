/**
 * 去AI味引擎：机械证据 + 语义诊断 + 历史避雷库。
 *
 * 设计原则（参考 AI-Novel-Writing-Assistant 的写法风险引擎与 BYWD-天宫 的检测面板）：
 * - 词表 / 统计命中只是「候选证据」，不单独判定违规；语义层由模型结合上下文判断。
 * - 语义问题必须带原文证据 excerpt，服务端逐字校验，找不到证据的条目直接丢弃。
 * - 机械分只衡量可量化的腔调特征，语义分衡量表达风险，两者独立展示，等级取较高者。
 * - 扫描结果留档（同一正文只记一次），据此形成趋势与「文风避雷库」，生成时自动注入。
 */
import { createHash } from 'node:crypto';
import { all, get, run, now } from './db.js';
import { callAI } from './ai.js';
import { parseJSONLoose, clip } from './util.js';
import * as P from './prompts.js';
import * as M from './mock.js';

const SETTINGS_KEY = 'flavor';
const LEVEL_RANK = { ok: 0, warn: 1, block: 2 };
const SEVERITY_WEIGHT = { low: 1, medium: 2, high: 3 };

export const DEFAULT_FLAVOR_SETTINGS = {
  wordEnabled: true,
  statEnabled: true,
  modelEnabled: false,
  avoidEnabled: true,
  warnThreshold: 40,
  blockThreshold: 70,
  avoidMinHits: 2,
  avoidLimit: 8,
};

/** 默认词表：[词, 原因, 建议, 严重度, 分类] */
const DEFAULT_WORDS = [
  ['仿佛', '高频虚化词，削弱现场感', '改为具体感官或删去', 'medium', '虚词'],
  ['宛如', '同「仿佛」，AI 高频词', '改用准确比喻或直接描写', 'medium', '虚词'],
  ['似乎', '猜测式虚词，削弱笃定', '给出确切动作/事实', 'medium', '虚词'],
  ['眼底闪过一丝', 'AI 招牌五官描写', '写具体动作或心理', 'high', '表情'],
  ['眼神中', '脸谱化表情套路', '用行为表现情绪', 'medium', '表情'],
  ['不由得', 'AI 高频连接词', '删去或改用节奏', 'low', '虚词'],
  ['默默', '笼统副词', '写实际动作', 'low', '虚词'],
  ['静静地', 'AI 高频叠词', '删去', 'low', '虚词'],
  ['隐隐', '虚化词', '删去或写实', 'medium', '虚词'],
  ['微微', 'AI 高频程度词', '删去或换更强动词', 'medium', '虚词'],
  ['缓缓', '流速副词滥用', '删去', 'medium', '虚词'],
  ['这便是', '总结式 AI 腔', '改为展示而非陈述', 'medium', '总结'],
  ['无法形容', '形容词偷懒', '写具体感受', 'high', '套话'],
  ['难以言喻', '同上', '写具体细节', 'high', '套话'],
  ['与此同时', 'AI 高频转场词', '重写转场', 'medium', '模板'],
  ['然而此刻', 'AI 高频转折', '精简', 'medium', '模板'],
  ['在这瞬间', 'AI 高频瞬间词', '删去', 'medium', '模板'],
  ['一股……的气息', 'AI 万能描述模板', '写具体五感', 'high', '模板'],
  ['莫名地', 'AI 高频虚词', '删去', 'medium', '虚词'],
  ['内心深处', 'AI 高频洞悉词', '改为行动', 'high', '心理'],
  ['此刻他的心中', '直白心理陈述', '克制传情，用细节', 'high', '心理'],
  ['仿佛整个……', '宏大虚写', '写具体', 'high', '模板'],
  ['能看出', '观察解释化', '改为动作', 'medium', '套话'],
  ['他们都知道', '旁白上帝视角', '改为视点内', 'high', '心理'],
  ['一个……的传说', 'AI 背景介绍模板', '融入情节', 'medium', '模板'],
  ['那道身影', 'AI 高频代称', '用名字或动作', 'medium', '套话'],
  ['目光变得深邃', 'AI 五官套路', '写具体行为', 'high', '表情'],
  ['嘴角勾起一抹', 'AI 表情套路', '写动作', 'high', '表情'],
  ['空气仿佛凝固', 'AI 氛围模板', '写具体反应', 'high', '模板'],
  ['没有人注意到', 'AI 转折铺垫', '写具体', 'medium', '模板'],
  // —— 解释型心理与总结腔 ——
  ['他感到', '解释型心理描写', '改成动作、语气、停顿或环境反应', 'high', '心理'],
  ['她感到', '解释型心理描写', '改成动作、语气、停顿或环境反应', 'high', '心理'],
  ['他意识到', '解释型心理描写', '用动作或选择体现认知变化', 'high', '心理'],
  ['她意识到', '解释型心理描写', '用动作或选择体现认知变化', 'high', '心理'],
  ['他明白了', '解释型心理描写', '用动作或反应替代', 'high', '心理'],
  ['她明白了', '解释型心理描写', '用动作或反应替代', 'high', '心理'],
  ['生活就是', '段尾升华 / 主题总结', '删掉升华，回到具体情境', 'high', '总结'],
  ['命运总会', '段尾升华 / 宿命总结', '删掉升华，落到具体选择', 'high', '总结'],
  ['归根结底', '总结主题', '让信息通过事件和结果自然显现', 'high', '总结'],
  ['说到底', '总结主题', '删去，直接给事实', 'medium', '总结'],
  ['这说明', '主题总结', '删掉结论，保留证据', 'high', '总结'],
  ['这意味着', '主题总结', '删掉解释，保留后果', 'high', '总结'],
  ['其实就是', '主题总结', '改为具体事件', 'medium', '总结'],
  ['我们都应该', '直接说教', '改成角色具体处境或对话', 'medium', '总结'],
  ['人总要学会', '直接说教', '让意义落在事件本身', 'medium', '总结'],
  ['真正重要的是', '直接说教', '不做抽象价值判断', 'medium', '总结'],
  // —— 氛围 / 身体反应套话 ——
  ['时间仿佛静止', 'AI 氛围模板', '写具体停顿或环境反应', 'high', '模板'],
  ['呼吸一滞', '身体反应套话', '写具体动作或后果', 'medium', '表情'],
  ['瞳孔骤缩', '身体反应套话', '写角色实际看到/做了什么', 'high', '表情'],
  ['心头一震', '身体反应套话', '换成动作或选择', 'medium', '表情'],
  ['心中一震', '身体反应套话', '换成动作或选择', 'medium', '表情'],
  ['嘴角微微上扬', 'AI 表情套路', '写具体动作或对话', 'high', '表情'],
  ['眼中闪过', 'AI 五官套路', '写具体视线落点与动作', 'high', '表情'],
  ['眼神复杂', 'AI 表情套路', '用行为表现矛盾', 'medium', '表情'],
  ['若有所思', '笼统表情套话', '写具体反应', 'medium', '表情'],
  ['意味深长', '笼统表情套话', '用台词或动作承载', 'medium', '表情'],
  ['一丝不易察觉的', 'AI 万能修饰', '删去或写可观察的细节', 'high', '套话'],
  ['不知过了多久', 'AI 时间省略模板', '给出具体时间线索', 'medium', '模板'],
  ['一阵沉默', 'AI 静态填充', '用动作或对话打断', 'low', '模板'],
  ['沉默良久', 'AI 静态填充', '给出具体动作或信息变化', 'medium', '模板'],
  ['深吸一口气', 'AI 高频准备动作', '删去或换成更具体的动作', 'low', '表情'],
  ['缓缓开口', 'AI 高频说话修饰', '直接出对话或加停顿', 'low', '虚词'],
];

export function buildDefaultRules() {
  return DEFAULT_WORDS.map(([phrase, reason, suggestion, severity, category], i) => ({
    id: `flv_${String(i + 1).padStart(3, '0')}`,
    phrase,
    reason: `命中 AI 腔词「${phrase}」：${reason}`,
    suggestion,
    severity,
    category,
    enabled: true,
  }));
}

/** 内置语义规则：不靠字面命中，交给模型结合上下文判断 */
export const SEMANTIC_RULES = [
  {
    id: 'anti_explain_psychology',
    name: '禁止解释型心理',
    type: 'forbidden',
    severity: 'high',
    instruction: '禁止「他感到 / 他意识到 / 他明白」式直接解释心理；人物状态必须通过动作、语气、停顿、选择或环境反应体现。',
    suggestion: '删掉心理解释，换成可观察的动作或反应。',
    autoRewrite: true,
  },
  {
    id: 'anti_ending_elevation',
    name: '禁止段尾升华',
    type: 'forbidden',
    severity: 'high',
    instruction: '禁止在段尾或章尾用总结句升华主题、提炼人生道理；收尾必须落回具体情境、动作或未决处境。',
    suggestion: '删除升华句，停在具体动作、对话或后果上。',
    autoRewrite: true,
  },
  {
    id: 'anti_theme_summary',
    name: '禁止总结主题',
    type: 'forbidden',
    severity: 'high',
    instruction: '禁止替读者总结中心思想、提炼意义或解释刚刚发生的事；信息通过事件和结果自然显现。',
    suggestion: '删掉总结句，保留事件与证据。',
    autoRewrite: true,
  },
  {
    id: 'anti_preaching',
    name: '禁止直接说教',
    type: 'forbidden',
    severity: 'medium',
    instruction: '禁止作者替角色或读者做价值判断与说教（「我们都应该」「真正重要的是」等）。',
    suggestion: '改成角色处境、选择或对话，不做抽象说教。',
    autoRewrite: true,
  },
  {
    id: 'anti_empty_lyricism',
    name: '空洞抒情 / 假热闹',
    type: 'risk',
    severity: 'high',
    instruction: '警惕用抽象意象、情绪排比、宏大形容词堆出「假热闹」，却没有新增信息、动作或关系变化。',
    suggestion: '删掉没有信息增量的抒情，换成具体动作或后果。',
    autoRewrite: true,
  },
  {
    id: 'anti_template_rhythm',
    name: '机械排比 / 均匀句式',
    type: 'risk',
    severity: 'medium',
    instruction: '警惕连续同构句、等长段落、机械排比与「不是……而是……」式模板；句式与段落应有自然起伏。',
    suggestion: '打散句式长度与起句方式，删掉空转的排比。',
    autoRewrite: true,
  },
  {
    id: 'anti_exposition_block',
    name: '连续解释没有动作',
    type: 'risk',
    severity: 'high',
    instruction: '警惕连续几段只有解释、背景说明或心理分析，没有动作、对话或场景反馈。',
    suggestion: '插入动作、对话或环境反馈，把设定拆进冲突里。',
    autoRewrite: false,
  },
  {
    id: 'anti_functional_dialogue',
    name: '对话纯功能推进',
    type: 'risk',
    severity: 'medium',
    instruction: '警惕对话只承担传递信息的功能，没有人物语气、停顿、绕弯或生活噪音。',
    suggestion: '补入停顿、回避、语气差异或无效信息。',
    autoRewrite: false,
  },
  {
    id: 'anti_static_padding',
    name: '静态动作填充',
    type: 'risk',
    severity: 'medium',
    instruction: '反复出现的看手机、翻身、心跳、望向窗外等动作，若不改变选择、信息或关系，也不产生新感受，视为静态填充。',
    suggestion: '删掉无变化的动作，或让它产生实际后果。',
    autoRewrite: true,
  },
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把带「……」的模板词转成可匹配正文的正则 */
function phrasePattern(phrase) {
  const parts = String(phrase).split(/…+|\.{3,}/).map((p) => escapeRegExp(p));
  return parts.join('.{0,12}?');
}

function clampThreshold(v) {
  return Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function normalizeRule(r, i) {
  const phrase = String(r?.phrase || '').trim();
  return {
    id: String(r?.id || `flv_c${i + 1}`),
    phrase: phrase.slice(0, 40),
    reason: String(r?.reason || `命中 AI 腔词「${phrase}」`).slice(0, 200),
    suggestion: String(r?.suggestion || '改写或删去').slice(0, 200),
    severity: ['low', 'medium', 'high'].includes(r?.severity) ? r.severity : 'medium',
    category: String(r?.category || '自定义').slice(0, 12),
    enabled: r?.enabled !== false,
  };
}

/** 读取配置：默认值 + 已保存设置，词表按 phrase 合并 */
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
    avoidEnabled: saved?.avoidEnabled !== false,
    warnThreshold: Number.isFinite(Number(saved?.warnThreshold)) ? clampThreshold(saved.warnThreshold) : DEFAULT_FLAVOR_SETTINGS.warnThreshold,
    blockThreshold: Number.isFinite(Number(saved?.blockThreshold)) ? clampThreshold(saved.blockThreshold) : DEFAULT_FLAVOR_SETTINGS.blockThreshold,
    avoidMinHits: clampInt(saved?.avoidMinHits, 1, 20, DEFAULT_FLAVOR_SETTINGS.avoidMinHits),
    avoidLimit: clampInt(saved?.avoidLimit, 1, 25, DEFAULT_FLAVOR_SETTINGS.avoidLimit),
  };
  const savedRules = Array.isArray(saved?.rules) ? saved.rules : [];
  const byPhrase = new Map(savedRules.map((r) => [String(r?.phrase || ''), r]));
  const rules = [];
  for (const d of buildDefaultRules()) {
    const s = byPhrase.get(d.phrase);
    rules.push(s ? normalizeRule({ ...d, ...s, id: d.id, phrase: d.phrase }, rules.length) : d);
  }
  for (const s of savedRules) {
    if (!s?.phrase || rules.some((r) => r.phrase === String(s.phrase))) continue;
    rules.push(normalizeRule(s, rules.length));
  }
  return { ...cfg, rules };
}

export function saveFlavorConfig(input = {}) {
  const prev = getFlavorConfig();
  const next = {
    wordEnabled: input.wordEnabled === undefined ? prev.wordEnabled : !!input.wordEnabled,
    statEnabled: input.statEnabled === undefined ? prev.statEnabled : !!input.statEnabled,
    modelEnabled: input.modelEnabled === undefined ? prev.modelEnabled : !!input.modelEnabled,
    avoidEnabled: input.avoidEnabled === undefined ? prev.avoidEnabled : !!input.avoidEnabled,
    warnThreshold: input.warnThreshold === undefined ? prev.warnThreshold : clampThreshold(input.warnThreshold),
    blockThreshold: input.blockThreshold === undefined ? prev.blockThreshold : clampThreshold(input.blockThreshold),
    avoidMinHits: input.avoidMinHits === undefined ? prev.avoidMinHits : clampInt(input.avoidMinHits, 1, 20, prev.avoidMinHits),
    avoidLimit: input.avoidLimit === undefined ? prev.avoidLimit : clampInt(input.avoidLimit, 1, 25, prev.avoidLimit),
    rules: Array.isArray(input.rules)
      ? input.rules
        .filter((r) => r && String(r.phrase || '').trim())
        .slice(0, 400)
        .map((r, i) => normalizeRule(r, i))
      : prev.rules,
  };
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    SETTINGS_KEY, JSON.stringify(next)
  );
  return next;
}

/* ============ 机械层：词表 ============ */

const DIALOGUE_PAIRS = { '“': '”', '「': '」', '『': '』' };

/** 标记对话区间：完整成对的引号内视为对白，未闭合的引号不标记（避免整章误判） */
function buildDialogueMask(text) {
  const mask = new Uint8Array(text.length);
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (DIALOGUE_PAIRS[ch]) {
      stack.push({ close: DIALOGUE_PAIRS[ch], at: i });
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && ch === top.close) {
      stack.pop();
      mask.fill(1, top.at, i + 1);
    }
  }
  return mask;
}

function inDialogue(mask, start, end) {
  if (!mask) return false;
  const from = Math.max(0, start);
  const to = Math.min(mask.length, end);
  for (let i = from; i < to; i++) {
    if (mask[i]) return true;
  }
  return false;
}

/** 逐条扫描词表；模板词按「……」展开；重叠命中只保留更长的那个 */
export function scanWordHits(text, rules) {
  const source = String(text || '');
  if (!source) return [];
  const dialogueMask = buildDialogueMask(source);
  const allHits = [];
  for (const rule of rules || []) {
    if (rule.enabled === false || !rule.phrase) continue;
    const re = new RegExp(phrasePattern(rule.phrase), 'g');
    let m;
    while ((m = re.exec(source)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      allHits.push({
        id: `flv_${rule.id}_${m.index}`,
        type: 'word',
        category: rule.category || '自定义',
        phrase: m[0],
        rulePhrase: rule.phrase,
        reason: rule.reason,
        suggestion: rule.suggestion,
        severity: rule.severity || 'medium',
        index: m.index,
        end: m.index + m[0].length,
        inDialogue: inDialogue(dialogueMask, m.index, m.index + m[0].length),
      });
    }
  }
  allHits.sort((a, b) => (a.index - b.index) || (b.phrase.length - a.phrase.length));
  const kept = [];
  let cursor = -1;
  for (const hit of allHits) {
    if (hit.index < cursor) continue;
    kept.push(hit);
    cursor = hit.end;
  }
  return kept.slice(0, 80);
}

/* ============ 机械层：统计信号 ============ */

function splitSentenceSpans(text) {
  const spans = [];
  let from = 0;
  const re = /[。！？!?]+[”"’']*|\.{3,}[”"’']*|…+[”"’']*|\n/g;
  const pushTrimmed = (start, end) => {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end > start) spans.push({ from: start, to: end });
  };
  let m;
  while ((m = re.exec(text)) !== null) {
    const to = m.index + m[0].length;
    pushTrimmed(from, to);
    from = to;
  }
  if (from < text.length) pushTrimmed(from, text.length);
  return spans;
}

const HEAD_STOPWORDS = new Set(
  '他她它我你您这那哪一不的是在有不就也又还都只才再更很太最和与及或被把让从向对为以于当如同若虽但而且则连每各某该此其之着过地得了么吗呢吧啊呀哦'.split('')
);

function countTerm(text, term, mask) {
  let count = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf(term, cursor);
    if (at < 0) break;
    /* 对白里的词更可能是人物口吻，不计入机械聚集信号 */
    if (!inDialogue(mask, at, at + term.length)) count++;
    cursor = at + term.length;
  }
  return count;
}

function firstOutsideDialogue(text, term, mask) {
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf(term, cursor);
    if (at < 0) return -1;
    if (!inDialogue(mask, at, at + term.length)) return at;
    cursor = at + term.length;
  }
  return -1;
}

/** 统计层：只给候选证据与证据片段，不直接判定违规 */
export function scanStatHits(text, options = {}) {
  const source = String(text || '');
  const hits = [];
  let score = 0;
  const push = (hit) => hits.push(hit);
  const dialogueMask = buildDialogueMask(source);
  const properNames = (options.properNames || []).filter((n) => n && String(n).trim());

  const spans = splitSentenceSpans(source);
  const sentences = spans
    .map((s) => source.slice(s.from, s.to).trim())
    .filter(Boolean);
  const lens = sentences.map((s) => s.replace(/\s/g, '').length);

  if (sentences.length >= 5) {
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (avg > 55) {
      score += 20;
      push({
        id: 'flv_avg_sentence', type: 'stat', code: 'rhythm.average-length',
        phrase: '平均句长过长',
        reason: `均值 ${avg.toFixed(0)} 字/句，AI 倾向长句堆叠`,
        suggestion: '拆短句、加对话与动作切分节奏',
        severity: 'medium', index: 0, end: 0, count: sentences.length,
      });
    }

    /* 用句首两字判断复读，并排除代词/虚词/人名地名，避免把正常中文主语误判成机械感 */
    const heads = new Map();
    for (const span of spans) {
      if (inDialogue(dialogueMask, span.from, span.to)) continue;
      const sentence = source.slice(span.from, span.to).trim();
      const head = sentence.slice(0, 2);
      if (head.length < 2 || HEAD_STOPWORDS.has(head[0])) continue;
      if (properNames.some((name) => sentence.startsWith(name) || head === Array.from(name).slice(0, 2).join(''))) continue;
      heads.set(head, (heads.get(head) || 0) + 1);
    }
    const repeats = [...heads.entries()].filter(([, n]) => n >= 3);
    if (repeats.length) {
      const names = repeats.map(([h, n]) => `「${h}」×${n}`).join('、');
      score += Math.min(10, repeats.length * 4);
      push({
        id: 'flv_head_repeat', type: 'stat', code: 'surface.repeated-sentence-head',
        phrase: `句首复读 ${names}`,
        reason: '句首两字高频重复，行文机械（已排除代词与常见虚词）',
        suggestion: '变化句首（主语/状语/直接出动作）',
        severity: 'medium', index: 0, end: 0, count: repeats.reduce((s, [, n]) => s + n, 0),
      });
    }
  }

  /* 长句 + 逗号密度：至少两处长句才计分，单处只作为候选证据展示 */
  const longList = [];
  for (const span of spans) {
    if (inDialogue(dialogueMask, span.from, span.to)) continue;
    const sentence = source.slice(span.from, span.to).trim();
    const chars = sentence.replace(/\s/g, '').length;
    const commas = (sentence.match(/[,，]/g) || []).length;
    if (chars >= 80 && commas >= 4) longList.push({ span, sentence, chars, commas });
  }
  if (longList.length >= 2) score += Math.min(16, longList.length * 8);
  const longSeverity = longList.length >= 2 ? 'medium' : 'low';
  for (const item of longList.slice(0, 2)) {
    push({
      id: `flv_long_${item.span.from}`, type: 'stat', code: 'rhythm.comma-density',
      phrase: `长句堆叠（${item.chars} 字 / ${item.commas} 逗号）`,
      reason: '单句过长且逗号密集，阅读节奏被拖慢',
      suggestion: '拆成两到三个短句，动作与信息分开落地',
      severity: longSeverity, index: item.span.from, end: item.span.from + item.sentence.length,
      excerpt: clip(item.sentence, 90), count: item.chars,
    });
  }

  /* 虚词 / 动作副词 / 身体反应 / 转场词聚集（只统计叙述，不统计对白） */
  const termGroups = [
    {
      code: 'surface.repeated-softeners', label: '虚词聚集',
      terms: ['似乎', '仿佛', '某种', '难以言喻', '莫名', '隐隐'],
      reason: '虚化修饰成簇出现，削弱笃定与现场感',
      suggestion: '删去虚词，给出确切动作或事实',
      severity: 'medium', weight: 6, min: 6,
    },
    {
      code: 'surface.action-adverb-stack', label: '动作副词堆叠',
      terms: ['缓缓', '微微', '轻轻', '不禁', '下意识', '忍不住', '悄然'],
      reason: '「副词 + 动词」堆叠，动作被稀释',
      suggestion: '换成更准确的动作，或直接删副词',
      severity: 'medium', weight: 6, min: 6,
    },
    {
      code: 'surface.body-reaction', label: '身体反应套话',
      terms: ['脸色', '眼神', '嘴角', '眼底', '呼吸', '瞳孔', '心头'],
      reason: '高频使用「五官/身体 + 反应」模板替代具体行为',
      suggestion: '换成纯动作、对话或可观察的后果',
      severity: 'medium', weight: 8, min: 8,
    },
    {
      code: 'template.transition', label: '模板转场词',
      terms: ['与此同时', '然而此刻', '在这瞬间', '就在这时', '不知过了多久', '总而言之', '综上所述'],
      reason: '转场依赖固定词块，段落推进机械',
      suggestion: '用动作、场景变化或时间线索重写转场',
      severity: 'low', weight: 4, min: 3,
    },
  ];

  for (const group of termGroups) {
    const matched = group.terms
      .map((term) => ({ term, count: countTerm(source, term, dialogueMask) }))
      .filter((x) => x.count > 0);
    const total = matched.reduce((s, x) => s + x.count, 0);
    if (total < group.min) continue;
    const first = group.terms
      .map((term) => ({ term, at: firstOutsideDialogue(source, term, dialogueMask) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    if (!first) continue;
    score += group.weight;
    push({
      id: `flv_${group.code}_${first.at}`, type: 'stat', code: group.code,
      phrase: `${group.label} ×${total}`,
      reason: `${group.reason}：${matched.map((x) => `「${x.term}」×${x.count}`).join('、')}（不含对白）`,
      suggestion: group.suggestion,
      severity: group.severity,
      index: first.at,
      end: first.at + first.term.length,
      excerpt: clip(source.slice(first.at, first.at + 60), 60),
      count: total,
    });
  }

  return { hits: hits.sort((a, b) => a.index - b.index), score: Math.min(50, score) };
}

/* ============ 语义层：模型诊断 ============ */

/** 内置规则 + 本书启用的自定义反AI规则，拼成目录文本 */
export function buildSemanticCatalog(projectId) {
  const custom = [];
  if (projectId) {
    const rows = all(
      "SELECT * FROM style_rules WHERE kind = 'anti_ai' AND enabled = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY project_id DESC, id",
      Number(projectId)
    );
    for (const row of rows) {
      custom.push({
        id: `rule_${row.id}`,
        name: row.name,
        type: 'risk',
        severity: 'medium',
        instruction: row.content,
        suggestion: '按规则要求改写，不要新增原文没有的事实。',
        autoRewrite: false,
      });
    }
  }
  const allRules = [...SEMANTIC_RULES, ...custom];
  const text = allRules
    .map((r) => `- [${r.id}] ${r.name} (${r.type}/${r.severity})：${r.instruction}`)
    .join('\n');
  return { rules: allRules, text };
}

/** 标准化原文坐标：去空白后的文本 + 每个字符对应的原始下标 */
function buildTextMap(text) {
  let normalized = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    normalized += text[i];
    map.push(i);
  }
  map.push(text.length);
  return { normalized, map };
}

/** 逐字校验模型给回的 excerpt，返回原文中的精确区间 */
function locateExcerpt(text, map, excerpt) {
  const needle = String(excerpt || '').replace(/\s+/g, '');
  if (!needle) return null;
  const at = map.normalized.indexOf(needle);
  if (at < 0) return null;
  const start = map.map[at];
  const lastIndex = map.map[at + needle.length - 1];
  if (lastIndex == null) return null;
  return { start, end: lastIndex + 1, excerpt: text.slice(start, lastIndex + 1) };
}

function normalizeViolation(raw, i, text, map, allowed) {
  const located = locateExcerpt(text, map, raw?.excerpt);
  if (!located) return null;
  const rule = allowed.find((r) => r.id === raw?.ruleId) ||
    allowed.find((r) => r.name === raw?.ruleName) || null;
  const reason = String(raw?.reason || '').trim();
  if (!reason) return null;
  const severity = ['low', 'medium', 'high'].includes(raw?.severity)
    ? raw.severity
    : (rule?.severity || 'medium');
  return {
    id: `flv_s_${i}_${located.start}`,
    ruleId: rule?.id || null,
    ruleName: rule?.name || String(raw?.ruleName || '反AI规则').slice(0, 40),
    ruleType: ['style', 'character', 'forbidden', 'risk', 'encourage'].includes(raw?.ruleType)
      ? raw.ruleType
      : (rule?.type || 'risk'),
    severity,
    start: located.start,
    end: located.end,
    excerpt: located.excerpt,
    reason: reason.slice(0, 300),
    suggestion: String(raw?.suggestion || rule?.suggestion || '按问题方向局部改写').slice(0, 300),
    canAutoRewrite: typeof raw?.canAutoRewrite === 'boolean' ? raw.canAutoRewrite : (rule?.autoRewrite !== false),
  };
}

/** 合并同一处重复问题：保留更严重 / 更长的一条，避免同一句被列出多次 */
function mergeViolations(list) {
  const rank = { low: 1, medium: 2, high: 3 };
  const sorted = [...list].sort((a, b) =>
    (rank[b.severity] || 2) - (rank[a.severity] || 2) ||
    (b.end - b.start) - (a.end - a.start) ||
    a.start - b.start
  );
  const kept = [];
  const seenExcerpts = new Set();
  for (const item of sorted) {
    const key = item.excerpt.replace(/\s+/g, '');
    if (seenExcerpts.has(key)) continue;
    if (kept.some((k) => item.start < k.end && item.end > k.start)) continue;
    seenExcerpts.add(key);
    kept.push(item);
  }
  return kept.sort((a, b) => a.start - b.start);
}

async function scanByModel(text, ctx = {}) {
  const catalog = buildSemanticCatalog(ctx.projectId);
  if (!catalog.rules.length) return null;
  const signals = (ctx.statHits || []).map((h) => ({
    signalCode: h.code || h.type,
    excerpt: h.excerpt || '',
    hits: h.count || 0,
  }));
  const { system, user } = P.flavorDetect(text, catalog.text, signals);
  try {
    const out = await callAI({
      task: 'reviewer', step: 'flavor_detect', system, user,
      projectId: ctx.projectId, chapterId: ctx.chapterId,
      temperature: 0,
      mock: () => M.flavorDetect(text),
    });
    const parsed = parseJSONLoose(out.text);
    if (!parsed || typeof parsed !== 'object') return null;
    const allowed = catalog.rules;
    const seen = new Set();
    const rawViolations = [];
    let dropped = 0;
    for (const raw of Array.isArray(parsed.violations) ? parsed.violations : []) {
      if (rawViolations.length >= 8) break;
      const item = normalizeViolation(raw, rawViolations.length, String(text), ctx.textMap, allowed);
      if (!item) { dropped++; continue; }
      const key = `${item.start}:${item.end}:${item.ruleName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rawViolations.push(item);
    }
    const violations = mergeViolations(rawViolations);
    let riskScore = Math.round(Number(parsed.riskScore));
    if (!Number.isFinite(riskScore)) {
      riskScore = Math.min(100, violations.reduce((s, v) => s + (SEVERITY_WEIGHT[v.severity] || 2) * 12, 0));
    }
    const summary = String(parsed.summary || '').trim() ||
      (violations.length ? `发现 ${violations.length} 处表达风险。` : '未发现明显的语义级 AI 腔。');
    return {
      enabled: true,
      riskScore: Math.max(0, Math.min(100, riskScore)),
      summary: summary.slice(0, 300),
      violations,
      dropped,
      ruleCount: allowed.length,
    };
  } catch {
    return null;
  }
}

/* ============ 汇总扫描 ============ */

function levelOf(value, cfg) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return n >= cfg.blockThreshold ? 'block' : n >= cfg.warnThreshold ? 'warn' : 'ok';
}

/**
 * 词表计分：按规则短语聚合，单一短语最多计 3 次，避免某个高频口头禅单独把分数拉爆；
 * 对白内命中最多计 2 次且每次 1 分，因为人物说话本就允许口语化。
 */
function scoreWordHits(hits) {
  const groups = new Map();
  for (const hit of hits) {
    const key = hit.rulePhrase || hit.phrase;
    const group = groups.get(key) || { weight: SEVERITY_WEIGHT[hit.severity] || 2, outside: 0, inside: 0 };
    if (hit.inDialogue) group.inside++;
    else group.outside++;
    groups.set(key, group);
  }
  let score = 0;
  for (const group of groups.values()) {
    score += Math.min(3, group.outside) * group.weight + Math.min(2, group.inside);
  }
  return Math.min(30, score);
}

function pickLevel(a, b) {
  if (LEVEL_RANK[b] > LEVEL_RANK[a]) return b;
  return a;
}

export async function scanFlavor(text, ctx = {}) {
  const cfg = ctx.config || getFlavorConfig();
  const source = String(text || '');
  const wordHits = cfg.wordEnabled ? scanWordHits(source, cfg.rules) : [];
  let properNames = ctx.properNames;
  if (cfg.statEnabled && !properNames && ctx.projectId) {
    try {
      properNames = [
        ...all('SELECT name FROM characters WHERE project_id = ?', Number(ctx.projectId)),
        ...all('SELECT name FROM world_entries WHERE project_id = ?', Number(ctx.projectId)),
      ].map((r) => r.name).filter(Boolean);
    } catch { properNames = []; }
  }
  const stat = cfg.statEnabled ? scanStatHits(source, { properNames }) : { hits: [], score: 0 };
  const wordScore = scoreWordHits(wordHits);
  const wordRules = new Set(wordHits.map((h) => h.rulePhrase || h.phrase)).size;
  const score = Math.max(0, Math.min(100, wordScore + stat.score));

  let semantic = null;
  if (cfg.modelEnabled && source.trim()) {
    semantic = await scanByModel(source, {
      ...ctx,
      statHits: stat.hits,
      textMap: buildTextMap(source),
    });
  }
  const riskScore = semantic?.riskScore ?? null;
  const mechanicalLevel = levelOf(score, cfg);
  const semanticLevel = levelOf(riskScore, cfg);
  const level = pickLevel(mechanicalLevel, semanticLevel || 'ok');
  const levelText = level === 'block' ? '需改写' : level === 'warn' ? '建议润色' : '尚可';

  const modelPart = semantic
    ? `语义风险 ${riskScore}（${semantic.violations.length} 处问题）。`
    : cfg.modelEnabled
      ? '语义诊断暂不可用。'
      : '';
  const summary = `AI 腔指数 ${score}（${levelText}）。词表命中 ${wordHits.length} 处 / ${wordRules} 类，统计信号 ${stat.hits.length}。${modelPart}`.trim();

  return {
    score,
    riskScore,
    level,
    levelText,
    summary,
    wordHits,
    statHits: stat.hits,
    violations: semantic?.violations || [],
    semantic: semantic || { enabled: false, riskScore: null, summary: '', violations: [], dropped: 0 },
    modelScore: riskScore,
    modelNote: semantic?.summary || '',
    thresholds: { warn: cfg.warnThreshold, block: cfg.blockThreshold },
    stats: {
      words: source.replace(/\s/g, '').length,
      wordScore,
      wordRules,
      statScore: stat.score,
      wordHits: wordHits.length,
      statHits: stat.hits.length,
      violations: semantic?.violations.length || 0,
      invalidEvidence: semantic?.dropped || 0,
    },
  };
}

/* ============ 历史留档与文风避雷库 ============ */

export function flavorHistory(projectId, limit = 12) {
  const rows = all(
    `SELECT id, chapter_id, chapter_idx, score, risk_score, level, words,
            word_hits, stat_hits, violations, summary, created_at
       FROM flavor_scans WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
    Number(projectId), Math.max(1, Math.min(50, Number(limit) || 12))
  );
  return rows.reverse();
}

/** 趋势：最小二乘斜率，沿用 BYWD 的 -5 / +5 作为升降判定 */
export function flavorTrend(projectId, limit = 12) {
  const rows = flavorHistory(projectId, limit);
  if (!rows.length) return null;
  const latest = rows[rows.length - 1].score;
  const first = rows[0].score;
  let slope = 0;
  if (rows.length >= 2) {
    const n = rows.length;
    const mid = (n - 1) / 2;
    const mean = rows.reduce((s, r) => s + r.score, 0) / n;
    let num = 0;
    let den = 0;
    rows.forEach((r, i) => {
      num += (i - mid) * (r.score - mean);
      den += (i - mid) ** 2;
    });
    slope = den > 0 ? num / den : 0;
  }
  const direction = slope <= -5 ? 'down' : slope >= 5 ? 'up' : 'flat';
  return {
    direction,
    slope: Math.round(slope * 10) / 10,
    latest,
    first,
    series: rows.map((r) => ({
      id: r.id,
      chapterIdx: r.chapter_idx,
      score: r.score,
      riskScore: r.risk_score,
      level: r.level,
      createdAt: r.created_at,
    })),
  };
}

/** 把一次扫描的词表命中累积进文风避雷库（同一正文只累积一次） */
function accumulateAvoidTerms(projectId, chapterIdx, wordHits, t) {
  const seen = new Set();
  for (const hit of wordHits || []) {
    const phrase = String(hit.phrase || '').trim();
    if (!phrase || phrase.length > 30 || seen.has(phrase)) continue;
    seen.add(phrase);
    run(
      `INSERT INTO flavor_avoid_terms (project_id, phrase, hits, last_chapter, suggestion, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(project_id, phrase) DO UPDATE SET
         hits = hits + 1,
         last_chapter = excluded.last_chapter,
         suggestion = CASE WHEN excluded.suggestion <> '' THEN excluded.suggestion ELSE suggestion END,
         updated_at = excluded.updated_at`,
      Number(projectId), phrase, 1, chapterIdx ?? null,
      String(hit.suggestion || '').slice(0, 200), t
    );
  }
}

/** 扫描留档：每章只保留最新一条，避免反复扫描把趋势刷成锯齿 */
export function recordFlavorScan({ projectId, chapterId, chapterIdx, text, report }) {
  if (!projectId || !report) return { recorded: false };
  const hash = createHash('sha256').update(String(text || '')).digest('hex');
  const t = now();
  const pid = Number(projectId);
  const cid = chapterId ? Number(chapterId) : null;
  const risk = report.riskScore ?? null;
  const summary = String(report.summary || '').slice(0, 400);

  const existing = cid != null
    ? get(
      `SELECT id, content_hash, risk_score, level, violations, summary
         FROM flavor_scans WHERE project_id = ? AND chapter_id = ?
        ORDER BY id DESC LIMIT 1`,
      pid, cid
    )
    : get(
      `SELECT id, content_hash, risk_score, level, violations, summary
         FROM flavor_scans WHERE project_id = ? AND chapter_id IS NULL AND content_hash = ?
        ORDER BY id DESC LIMIT 1`,
      pid, hash
    );

  const sameContent = !!existing && existing.content_hash === hash;
  /* 正文没变且本次没跑语义层时，沿用上次语义结果，避免分数倒退 */
  const keepSemantic = sameContent && risk == null;
  const finalRisk = keepSemantic ? existing.risk_score : risk;
  const finalLevel = keepSemantic ? (existing.level || report.level || 'ok') : (report.level || 'ok');
  const finalViolations = keepSemantic ? (existing.violations || 0) : (report.violations?.length || 0);
  const finalSummary = keepSemantic ? (existing.summary || '') : summary;

  if (existing) {
    if (cid != null) run('DELETE FROM flavor_scans WHERE project_id = ? AND chapter_id = ?', pid, cid);
    else run('DELETE FROM flavor_scans WHERE project_id = ? AND chapter_id IS NULL', pid);
  }

  run(
    `INSERT INTO flavor_scans
      (project_id, chapter_id, chapter_idx, content_hash, score, risk_score, level, words,
       word_hits, stat_hits, violations, summary, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid, cid, chapterIdx ?? null, hash,
    report.score || 0, finalRisk, finalLevel,
    report.stats?.words || 0, report.wordHits?.length || 0, report.statHits?.length || 0,
    finalViolations, finalSummary, t
  );

  if (!sameContent) accumulateAvoidTerms(pid, chapterIdx, report.wordHits, t);
  return { recorded: !existing, updated: !!existing, sameContent };
}

/** 文风避雷库：按累计命中次数排序，供生成前注入 */
export function buildAvoidList(projectId, minHits = 2, limit = 8) {
  if (!projectId) return [];
  return all(
    `SELECT phrase, hits, last_chapter AS lastChapter, suggestion
       FROM flavor_avoid_terms
      WHERE project_id = ? AND hits >= ?
      ORDER BY hits DESC, updated_at DESC
      LIMIT ?`,
    Number(projectId), Math.max(1, Number(minHits) || 2), Math.max(1, Math.min(25, Number(limit) || 8))
  );
}

export function clearAvoidList(projectId) {
  if (!projectId) return 0;
  return run('DELETE FROM flavor_avoid_terms WHERE project_id = ?', Number(projectId)).changes || 0;
}

/** 给改写 / 修复提示词用的禁用表达与避雷库文本，避免替换时换入另一个模板词 */
export function buildLexiconText(cfg = getFlavorConfig(), avoid = []) {
  const lexiconText = cfg.wordEnabled
    ? cfg.rules
      .filter((r) => r.enabled !== false)
      .slice(0, 20)
      .map((r) => `- 「${r.phrase}」→ ${r.suggestion || '换具体写法'}`)
      .join('\n')
    : '';
  const avoidText = (avoid || [])
    .map((a) => `- 「${a.phrase}」（已出现 ${a.hits} 次）→ ${a.suggestion || '换具体写法'}`)
    .join('\n');
  return { lexiconText, avoidText };
}
