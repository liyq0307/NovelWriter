/**
 * 提示词模板：项目级覆盖内置提示词。
 * - system 非空时整体替换系统提示词
 * - suffix 非空时追加到用户提示词末尾
 * 所有 callAI 调用都会自动应用，无需在各业务路由里重复处理。
 */
import { all, get, run, now } from './db.js';

export const PROMPT_STEPS = [
  { step: 'directions', label: '开书方向', desc: '根据灵感生成候选方向' },
  { step: 'world', label: '世界设定', desc: '起草地理 / 势力 / 规则 / 物品 / 历史' },
  { step: 'characters', label: '角色设计', desc: '设计核心人物与关系网' },
  { step: 'outline', label: '卷纲规划', desc: '规划卷级弧线与高潮' },
  { step: 'chapter_plan', label: '节奏拆章', desc: '把卷纲拆成逐章任务单' },
  { step: 'write', label: '正文生成', desc: '按任务单写整章正文' },
  { step: 'continue', label: '衔接续写', desc: '从光标处无缝续写' },
  { step: 'rewrite', label: '局部改写', desc: '按指令改写选中片段' },
  { step: 'flavor_rewrite', label: '去AI味改写', desc: '清除选中片段的 AI 腔' },
  { step: 'review', label: '章节检查', desc: '评审并给出问题清单' },
  { step: 'revise', label: '按意见修文', desc: '根据检查结果重写整章' },
  { step: 'post_write', label: '写后整理', desc: '摘要 / 角色状态 / 线索 / 事实' },
  { step: 'thread_extract', label: '线索补录', desc: '从正文中提取伏笔线索' },
  { step: 'deconstruct', label: '拆书分析', desc: '分析参考作品的结构与写法' },
];

const STEP_SET = new Set(PROMPT_STEPS.map((s) => s.step));

/** 取生效模板：本书覆盖优先，其次全局（project_id=0） */
export function getTemplate(projectId, step) {
  if (!STEP_SET.has(step)) return null;
  const pid = Number(projectId) || 0;
  return get('SELECT * FROM prompt_templates WHERE step = ? AND project_id IN (?, 0) ORDER BY project_id DESC LIMIT 1', step, pid);
}

/** 把模板覆盖应用到一组提示词上 */
export function applyTemplate(step, projectId, { system = '', user = '' } = {}) {
  const row = getTemplate(projectId, step);
  if (!row) return { system, user };
  const s = String(row.system || '').trim();
  const suffix = String(row.suffix || '').trim();
  return {
    system: s ? s : system,
    user: suffix ? `${user}\n\n【本书补充要求】\n${suffix}` : user,
  };
}

/** 模板总览（含是否覆盖、更新时间） */
export function listTemplates(projectId) {
  const pid = Number(projectId) || 0;
  const rows = all('SELECT * FROM prompt_templates WHERE project_id = ?', pid);
  const globalRows = all('SELECT * FROM prompt_templates WHERE project_id = 0');
  const map = new Map(rows.map((r) => [r.step, r]));
  const gmap = new Map(globalRows.map((r) => [r.step, r]));
  return PROMPT_STEPS.map((meta) => {
    const own = map.get(meta.step);
    const g = gmap.get(meta.step);
    const effective = own || g || null;
    return {
      ...meta,
      system: effective?.system || '',
      suffix: effective?.suffix || '',
      overridden: !!own,
      global: !own && !!g,
      updated_at: own?.updated_at || null,
    };
  });
}

/** 保存覆盖，旧版本写入历史 */
export function saveTemplate(projectId, step, { system = '', suffix = '' }) {
  if (!STEP_SET.has(step)) throw new Error('未知的提示词步骤');
  const pid = Number(projectId) || 0;
  const systemText = String(system || '').slice(0, 8000);
  const suffixText = String(suffix || '').slice(0, 4000);
  const t = now();
  const prev = get('SELECT * FROM prompt_templates WHERE project_id = ? AND step = ?', pid, step);
  if (prev) {
    if (prev.system === systemText && prev.suffix === suffixText) return prev;
    run('INSERT INTO prompt_template_history (template_id, project_id, step, system, suffix, created_at) VALUES (?,?,?,?,?,?)',
      prev.id, pid, step, prev.system, prev.suffix, t);
    run('UPDATE prompt_templates SET system = ?, suffix = ?, updated_at = ? WHERE id = ?',
      systemText, suffixText, t, prev.id);
    return get('SELECT * FROM prompt_templates WHERE id = ?', prev.id);
  }
  const info = run('INSERT INTO prompt_templates (project_id, step, system, suffix, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    pid, step, systemText, suffixText, t, t);
  return get('SELECT * FROM prompt_templates WHERE id = ?', info.lastInsertRowid);
}

/** 删除覆盖，回落到默认 / 全局 */
export function resetTemplate(projectId, step) {
  const pid = Number(projectId) || 0;
  const prev = get('SELECT * FROM prompt_templates WHERE project_id = ? AND step = ?', pid, step);
  if (prev) {
    run('INSERT INTO prompt_template_history (template_id, project_id, step, system, suffix, created_at) VALUES (?,?,?,?,?,?)',
      prev.id, pid, step, prev.system, prev.suffix, now());
    run('DELETE FROM prompt_templates WHERE id = ?', prev.id);
  }
  return { ok: true };
}

export function templateHistory(projectId, step) {
  const pid = Number(projectId) || 0;
  return all(
    `SELECT id, system, suffix, created_at FROM prompt_template_history
     WHERE project_id = ? AND step = ? ORDER BY id DESC LIMIT 20`,
    pid, step
  );
}

/** 回滚到某个历史版本 */
export function rollbackTemplate(projectId, step, historyId) {
  const pid = Number(projectId) || 0;
  const h = get('SELECT * FROM prompt_template_history WHERE id = ? AND project_id = ? AND step = ?',
    Number(historyId), pid, step);
  if (!h) throw new Error('历史版本不存在');
  return saveTemplate(pid, step, { system: h.system, suffix: h.suffix });
}
