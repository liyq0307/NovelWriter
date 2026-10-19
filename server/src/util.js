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
