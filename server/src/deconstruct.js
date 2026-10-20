/**
 * 拆书（参考作品分析）：文本清洗、自动分章、文本统计与采样。
 * 只做确定性的文本处理；结构 / 人物 / 写法的判断交给模型。
 */
import { countWords, clip } from './util.js';

/** 统一换行、去 BOM、压缩多余空行 */
export function normalizeText(raw) {
  return String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

const HEAD_RE = /^[ \t]*(第[零〇一二三四五六七八九十百千万两\d]{1,8}[章节回卷篇][^\n]{0,40}|(?:Chapter|CHAPTER)\s+[0-9IVXLC]+[^\n]{0,40})[ \t]*$/gm;
const PART_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 自动分章：优先识别「第X章 / Chapter N」，否则按空行聚合为等长片段 */
export function splitChapters(raw) {
  const text = normalizeText(raw);
  if (!text) return [];
  const marks = [...text.matchAll(HEAD_RE)].map((m) => ({
    title: m[1].trim(),
    index: m.index || 0,
    length: m[0].length,
  }));
  const chapters = [];

  if (marks.length >= 2) {
    const preface = text.slice(0, marks[0].index).trim();
    if (preface.length > 120) {
      chapters.push({ idx: 1, title: '序章', content: preface, words: countWords(preface) });
    }
    marks.forEach((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
      // 用整行匹配长度切分，兼容标题行前的缩进
      const body = text.slice(m.index + m.length, end).trim();
      if (!body) return;
      chapters.push({
        idx: chapters.length + 1,
        title: clip(m.title.replace(/\s+/g, ' '), 40),
        content: body,
        words: countWords(body),
      });
    });
  } else if (marks.length === 1) {
    const body = text.slice(marks[0].index + marks[0].length).trim();
    chapters.push({ idx: 1, title: clip(marks[0].title, 40) || '全文', content: body || text, words: countWords(body || text) });
  } else {
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const body = buf.join('\n\n');
      chapters.push({
        idx: chapters.length + 1,
        title: `第${PART_NUM[chapters.length] || chapters.length + 1}部分`,
        content: body,
        words: countWords(body),
      });
      buf = [];
    };
    for (const p of paras) {
      buf.push(p);
      if (countWords(buf.join('')) >= 3500) flush();
      if (chapters.length >= 60) break;
    }
    flush();
  }

  return chapters.slice(0, 100).map((c, i) => ({ ...c, idx: i + 1 }));
}

/** 文本层统计：给模型一份可量化的「体检报告」 */
export function analyzeStats(chapters) {
  const text = chapters.map((c) => c.content).join('\n');
  const totalWords = countWords(text);
  const dialogues = text.match(/[「“"][^」”"]{1,200}[」”"]/g) || [];
  const dialogueWords = countWords(dialogues.join(''));
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences = text.split(/[。！？!?…]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
  const avgSentence = sentences.length ? Math.round(totalWords / sentences.length) : 0;
  const avgParagraph = paragraphs.length ? Math.round(totalWords / paragraphs.length) : 0;
  const firstPerson = (text.match(/我/g) || []).length;
  const thirdPerson = (text.match(/[他她]/g) || []).length;
  return {
    totalWords,
    chapterCount: chapters.length,
    avgChapterWords: chapters.length ? Math.round(totalWords / chapters.length) : 0,
    dialogueRatio: totalWords ? Math.round((dialogueWords / totalWords) * 100) : 0,
    paragraphCount: paragraphs.length,
    avgParagraph,
    sentenceCount: sentences.length,
    avgSentence,
    povGuess: firstPerson > thirdPerson * 1.2 ? '第一人称倾向' : thirdPerson > firstPerson * 1.2 ? '第三人称倾向' : '人称混用/不易判断',
  };
}

/** 采样：章节表 + 首章开篇 + 若干章开头 + 末章结尾，控制提示词长度 */
export function buildDigest(chapters) {
  if (!chapters.length) return '（无正文）';
  const lines = [];
  lines.push('【章节结构】');
  for (const c of chapters.slice(0, 60)) {
    lines.push(`- 第${c.idx}章《${c.title}》 ${c.words} 字`);
  }
  if (chapters.length > 60) lines.push(`- ……（共 ${chapters.length} 章）`);

  lines.push('\n【开篇样本】');
  lines.push(clip(chapters[0].content, 800));

  if (chapters.length > 2) {
    lines.push('\n【中段样本】');
    const step = Math.max(1, Math.floor(chapters.length / 4));
    for (const i of [step, step * 2].filter((x) => x < chapters.length - 1)) {
      lines.push(`- 第${chapters[i].idx}章《${chapters[i].title}》开头：${clip(chapters[i].content, 300)}`);
    }
    lines.push('\n【结尾样本】');
    const last = chapters[chapters.length - 1];
    lines.push(`第${last.idx}章《${last.title}》结尾：${clip(last.content.slice(-600), 600)}`);
  }
  return lines.join('\n');
}

/** 拆解结果规范化，避免前端拿到脏结构 */
export function normalizeAnalysis(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const style = obj.style && typeof obj.style === 'object' ? obj.style : {};
  return {
    summary: String(obj.summary || '').slice(0, 600),
    structure: {
      pattern: String(obj.structure?.pattern || '').slice(0, 120),
      beats: (Array.isArray(obj.structure?.beats) ? obj.structure.beats : []).map((x) => String(x).slice(0, 150)).slice(0, 12),
    },
    characters: (Array.isArray(obj.characters) ? obj.characters : [])
      .filter((c) => c && c.name)
      .map((c) => ({
        name: String(c.name).slice(0, 40),
        role: String(c.role || '').slice(0, 30),
        want: String(c.want || '').slice(0, 200),
        flaw: String(c.flaw || '').slice(0, 200),
        arc: String(c.arc || '').slice(0, 200),
      }))
      .slice(0, 10),
    style: {
      pov: String(style.pov || '').slice(0, 60),
      tone: String(style.tone || '').slice(0, 120),
      sentence: String(style.sentence || '').slice(0, 160),
      dialogue: String(style.dialogue || '').slice(0, 160),
      description: String(style.description || '').slice(0, 160),
      pacing: String(style.pacing || '').slice(0, 160),
      signature: (Array.isArray(style.signature) ? style.signature : []).map((x) => String(x).slice(0, 60)).slice(0, 10),
    },
    techniques: (Array.isArray(obj.techniques) ? obj.techniques : []).map((x) => String(x).slice(0, 200)).slice(0, 10),
    rules: (Array.isArray(obj.rules) ? obj.rules : [])
      .filter((r) => r && r.name && r.content)
      .map((r) => ({
        name: String(r.name).slice(0, 60),
        content: String(r.content).slice(0, 400),
        kind: r.kind === 'anti_ai' ? 'anti_ai' : 'style',
      }))
      .slice(0, 12),
  };
}
