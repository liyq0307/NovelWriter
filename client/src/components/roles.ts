/** 角色定位 → 图形/徽标用的稳定 class 后缀 */
export const ROLE_ORDER = ['主角', '重要配角', '反派', '配角', '未知'];

export function roleKey(role: string): string {
  if (role === '主角') return 'lead';
  if (role === '重要配角') return 'major';
  if (role === '反派') return 'villain';
  if (role === '配角') return 'minor';
  return 'other';
}
