/** API 客户端：JSON 请求 + SSE 流式读取 */

async function req(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败 HTTP ${res.status}`);
    (err as any).status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (u: string) => req('GET', u),
  post: (u: string, b?: unknown) => req('POST', u, b ?? {}),
  put: (u: string, b?: unknown) => req('PUT', u, b ?? {}),
  patch: (u: string, b?: unknown) => req('PATCH', u, b ?? {}),
  del: (u: string) => req('DELETE', u),
};

export interface SSEHandlers {
  onStart?: (d: any) => void;
  onDelta?: (d: { text: string }) => void;
  onDone?: (d: { text: string; wordCount?: number; model?: string; mock?: boolean; warning?: string | null }) => void;
  onError?: (d: { message: string }) => void;
  /** 所有事件的通用回调（批量连写等自定义事件） */
  onEvent?: (event: string, d: any) => void;
}

/** POST 请求的 SSE 流式读取 */
export async function sse(url: string, body: unknown, h: SSEHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api' + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    h.onError?.({ message: '网络连接中断' });
    return;
  }
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* 保留默认 */ }
    h.onError?.({ message: msg });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const dispatch = (frame: string) => {
    let ev = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let parsed: any;
    try { parsed = JSON.parse(data); } catch { return; }
    h.onEvent?.(ev, parsed);
    if (ev === 'start') h.onStart?.(parsed);
    else if (ev === 'delta') h.onDelta?.(parsed);
    else if (ev === 'done') h.onDone?.(parsed);
    else if (ev === 'error') h.onError?.(parsed);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        dispatch(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    if (buf.trim()) dispatch(buf);
  } catch {
    h.onError?.({ message: '生成中断：连接被断开，已生成部分可手动保存' });
  }
}

/** 中文字数（与后端口径一致：去空白计数） */
export function countWords(text: string): number {
  return (text || '').replace(/\s/g, '').length;
}

/** 章节序号 → 中文数字（1-99 之外用阿拉伯数字） */
export function cnNum(n: number): string {
  if (n <= 0 || n > 99) return String(n);
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  if (tens === 0) return d[ones];
  if (tens === 1) return ones ? '十' + d[ones] : '十';
  return d[tens] + '十' + (ones ? d[ones] : '');
}

export function fmtTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export const STEP_NAMES: Record<string, string> = {
  directions: '开书方向',
  directions_merge: '方向融合',
  world: '世界设定',
  characters: '角色设计',
  outline: '卷纲规划',
  chapter_plan: '节奏拆章',
  write: '正文生成',
  continue: '衔接续写',
  rewrite: '局部改写',
  flavor_detect: '去AI味诊断',
  flavor_rewrite: '去AI味改写',
  flavor_repair: '去AI味整章修复',
  review: '章节检查',
  revise: '按意见修文',
  state_sync: '状态同步',
  post_write: '写后整理',
  thread_extract: '线索补录',
  deconstruct: '拆书分析',
  test: '连接测试',
};

export const THREAD_KINDS = ['伏笔', '线索', '悬念', '承诺'] as const;

export const THREAD_STATUS_NAMES: Record<string, string> = {
  planted: '已埋',
  reinforced: '推进中',
  resolved: '已回收',
  abandoned: '已放弃',
};

export const THREAD_STATUS_TONE: Record<string, 'warn' | 'info' | 'ok' | 'default'> = {
  planted: 'warn',
  reinforced: 'info',
  resolved: 'ok',
  abandoned: 'default',
};

export const REVISION_REASON_NAMES: Record<string, string> = {
  autosave: '自动保存',
  generate: '生成采纳',
  batch: '批量连写',
  'pre-revise': '修文前原稿',
  revise: '按意见修文',
  restore: '回滚',
  'restore-prev': '回滚前存档',
  manual: '手动存档',
  clear: '清空',
};

/** 本地日期键（YYYY-MM-DD） */
export function dayKey(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const STATUS_NAMES: Record<string, string> = {
  idea: '待定方向',
  direction: '已定方向',
  building: '资料完善中',
  planned: '已规划待写',
  writing: '连载中',
  done: '已完结',
};
