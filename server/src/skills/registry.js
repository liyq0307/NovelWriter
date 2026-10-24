const registry = new Map();

export function registerSkill(skill) {
  if (!skill?.id || !Array.isArray(skill.capabilities)) throw new Error('skill 定义不完整');
  for (const cap of skill.capabilities) {
    if (typeof skill[cap] !== 'function') throw new Error(`skill ${skill.id} 缺少能力 ${cap}`);
  }
  registry.set(skill.id, skill);
  return skill;
}

export function listSkills() {
  return [...registry.values()].map(({ id, label, version, capabilities, source }) => ({
    id, label, version, capabilities: [...capabilities], source: source || [],
  }));
}

/**
 * 统一的 skill 执行入口。能力实现抛错或缺失时走 fallback，
 * 返回值统一带上 skill / degraded，调用方无需关心底层是技能还是内置降级实现。
 */
export function runSkill(id, capability, ctx, fallback) {
  const skill = registry.get(id);
  try {
    if (!skill) throw new Error(`未注册的 skill：${id}`);
    if (!skill.capabilities.includes(capability)) throw new Error(`skill ${id} 不支持能力 ${capability}`);
    return { ...skill[capability](ctx || {}), skill: skill.id, degraded: false };
  } catch (e) {
    if (typeof fallback !== 'function') throw e;
    return { ...fallback(), skill: 'builtin', degraded: true, reason: e?.message || 'skill 执行失败' };
  }
}
