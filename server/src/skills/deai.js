import { readFileSync } from 'node:fs';
import * as P from '../prompts.js';
import { registerSkill, runSkill } from './registry.js';

/*
 * 技能文本来自以下两个仓库，按 SKILL.md 原文内置，运行时不联网：
 * - ai-zixun/humanizer-zh @ f75f1ac（v1.3.0）
 * - OUBIGFA/De-AI-Prompt-Enhancer-Writer-Booster-SKILL @ 59eafed（de-AI-writing v2.1）
 */
const SKILL_ID = 'deai-humanizer';
const SOURCES = [
  'https://github.com/ai-zixun/humanizer-zh',
  'https://github.com/OUBIGFA/De-AI-Prompt-Enhancer-Writer-Booster-SKILL',
];

const OPERATION_NOTE = '本次调用运行在小说写作台的 API 中：只处理用户给出的片段，保持原有人称与视角；不要输出诊断清单、评分、Markdown 标题或说明，只返回最终片段正文。';

let docs = null;

function stripFrontMatter(text) {
  return String(text).replace(/^---[\s\S]*?---\s*/, '').trim();
}

function readSkill(rel) {
  return stripFrontMatter(readFileSync(new URL(`./vendor/${rel}`, import.meta.url), 'utf8'));
}

/** 延迟加载：文件缺失或为空时抛错，由 registry 捕获并降级到内置提示词 */
function loadSkillDocs() {
  if (docs) return docs;
  const humanizer = readSkill('humanizer-zh/SKILL.md');
  const deaiWriting = readSkill('de-AI-writing/SKILL.md');
  const narrative = readSkill('de-AI-writing/references/narrative-pass.md');
  if (!humanizer || !deaiWriting || !narrative) throw new Error('去AI味技能文件为空');
  docs = { humanizer, deaiWriting, narrative };
  return docs;
}

/** 按技能开关拼装系统提示：关闭的技能不注入，全关时抛错交给 registry 降级为内置提示词 */
function withSkill(system, docs, includeDeai, skills = {}) {
  const humanizerOn = skills.humanizer !== false;
  const deaiOn = skills.deai !== false;
  const parts = [system];
  if (humanizerOn) parts.push(docs.humanizer);
  if (includeDeai && deaiOn) parts.push(docs.deaiWriting, docs.narrative, OPERATION_NOTE);
  if (parts.length === 1) throw new Error('去AI味技能均已关闭');
  return parts.join('\n\n');
}

/** 清掉模型偶尔带出的“改写后的片段：”等元信息，避免写回正文时反复出现前缀 */
function cleanRewrite(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^【(?:改写|润色|修改|演示|结果|输出)[^】]*】[^\n]*\n+/, '').trim();
  text = text.replace(/^(?:改写|润色|修改|结果|输出)[^\n]{0,20}[:：]\s*\n?/, '').trim();
  return text;
}

const deaiSkill = {
  id: SKILL_ID,
  label: '中文去AI味（humanizer-zh + de-AI-writing）',
  version: 'humanizer-zh 1.3.0 / de-AI-writing 2.1',
  source: SOURCES,
  capabilities: ['detect', 'rewrite', 'repair'],

  detect({ text, catalogText, signals = [], skills = {} }) {
    const prompt = P.flavorDetect(text, catalogText, signals);
    return { ...prompt, system: withSkill(prompt.system, loadSkillDocs(), false, skills) };
  },

  rewrite({ selection, hits = [], before = '', after = '', lexiconText = '', avoidText = '', skills = {} }) {
    const prompt = P.flavorRewrite(selection, hits, before, after, lexiconText, avoidText);
    return { ...prompt, system: withSkill(prompt.system, loadSkillDocs(), true, skills) };
  },

  repair({ text, issues = [], lexiconText = '', avoidText = '', skills = {} }) {
    const prompt = P.flavorRepair(text, issues, lexiconText, avoidText);
    return { ...prompt, system: withSkill(prompt.system, loadSkillDocs(), true, skills) };
  },
};

registerSkill(deaiSkill);

/** 业务层唯一入口：技能可用时走技能，异常时降级为内置提示词，保证去AI味链路不中断 */
export function buildFlavorPrompt(step, ctx = {}) {
  return runSkill(SKILL_ID, step, ctx, () => {
    if (step === 'detect') return P.flavorDetect(ctx.text, ctx.catalogText, ctx.signals || []);
    if (step === 'rewrite') {
      return P.flavorRewrite(ctx.selection, ctx.hits || [], ctx.before || '', ctx.after || '', ctx.lexiconText || '', ctx.avoidText || '');
    }
    if (step === 'repair') return P.flavorRepair(ctx.text, ctx.issues || [], ctx.lexiconText || '', ctx.avoidText || '');
    throw new Error(`未知的去AI味能力：${step}`);
  });
}

export { cleanRewrite };
