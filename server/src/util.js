/** 常用工具：字数统计、容错 JSON 解析、SSE 编码 */

/** 中文字数（去掉所有空白字符后计数） */
export function countWords(text = '') {
  return (text || '').replace(/\s/g, '').length;
}

/**
 * 从模型输出中截取第一个平衡的 JSON 对象或数组（忽略代码围栏、前后说明文字）。
 * 正确跳过字符串内的花括号与转义字符。
 */
export function extractJSON(text) {
  if (!text) return null;
  const t = String(text);
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '{' && c !== '[') continue;
    const open = c;
    const close = c === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < t.length; j++) {
      const d = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (d === '\\') esc = true;
        else if (d === '"') inStr = false;
        continue;
      }
      if (d === '"') { inStr = true; continue; }
      if (d === open) depth++;
      else if (d === close) {
        depth--;
        if (depth === 0) return t.slice(i, j + 1);
      }
    }
    return null; // 有起始符但不平衡
  }
  return null;
}

/** 容错解析 JSON：容忍尾逗号、中文引号 */
export function parseJSONLoose(text) {
  const s = extractJSON(text);
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 继续尝试修复 */ }
  try {
    return JSON.parse(
      s
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
    );
  } catch { return null; }
}

/** SSE 帧 */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 截断文本用于提示词 */
export function clip(text, n) {
  const t = (text || '').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '……';
}

/** 归一化文本：去掉空白、标点与符号，英文转小写，用于比对重复表述 */
export function normalizeText(text = '') {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 字符二元组 Dice 相似度（0-1） */
export function textSimilarity(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = grams(x);
  const B = grams(y);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    const m = B.get(g);
    if (m) inter += Math.min(n, m);
  }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

/** 判断两条事实是否在说同一件事：短句只认完全相同，长句允许表述差异 */
const OPPOSITES = [
  ['抵达', '离开'], ['到达', '离开'], ['得到', '失去'], ['获得', '失去'],
  ['出生', '死亡'], ['存活', '死亡'], ['生还', '死亡'],
  ['开启', '关闭'], ['打开', '关闭'], ['点燃', '熄灭'], ['亮起', '熄灭'],
  ['成功', '失败'], ['上升', '下降'], ['增加', '减少'], ['恢复', '恶化'],
  ['救', '杀'], ['保护', '伤害'], ['信任', '怀疑'], ['结盟', '背叛'],
  ['北', '南'], ['东', '西'], ['左', '右'], ['内', '外'], ['上', '下'], ['前', '后'],
];
const NEGATIONS = ['不', '未', '没', '无', '别', '莫', '非'];

/** 语义相反 / 关键数字不同的句子，即使字面很像也不能合并 */
function hasOppositeMeaning(x, y) {
  for (const [a, b] of OPPOSITES) {
    if ((x.includes(a) && y.includes(b)) || (x.includes(b) && y.includes(a))) return true;
  }
  const negX = NEGATIONS.some((w) => x.includes(w));
  const negY = NEGATIONS.some((w) => y.includes(w));
  if (negX !== negY) return true;
  const nums = (s) => (s.match(/\d+/g) || []).sort().join(',');
  const nx = nums(x);
  const ny = nums(y);
  return !!nx && !!ny && nx !== ny;
}

export function isSameFact(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 12 || y.length < 12) return false;
  if (hasOppositeMeaning(x, y)) return false;
  return textSimilarity(a, b) >= 0.72;
}
