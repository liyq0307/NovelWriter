/**
 * AI 网关：统一封装模型调用。
 * - OpenAI 兼容 /chat/completions（适配 DeepSeek / Kimi / GLM / Qwen / OpenAI 等），流式输出
 * - 按任务路由模型：planner 规划 / writer 正文 / reviewer 审阅
 * - 每次调用写入 ai_calls（用量与运行记录）
 * - Mock 演示模式：无 Key 时由 mock.js 产出结构化演示内容
 */
import { get, run, now } from './db.js';
import { countWords } from './util.js';
import { applyTemplate } from './templates.js';

const DEFAULTS = { provider: 'mock', baseUrl: '', apiKey: '', models: { planner: '', writer: '', reviewer: '' } };

export function getAISettings() {
  const row = get('SELECT value FROM settings WHERE key = ?', 'ai');
  if (row) {
    try {
      const s = JSON.parse(row.value);
      return {
        provider: s.provider === 'openai' ? 'openai' : 'mock',
        baseUrl: s.baseUrl || '',
        apiKey: s.apiKey || '',
        models: {
          planner: s.models?.planner || '',
          writer: s.models?.writer || '',
          reviewer: s.models?.reviewer || '',
        },
      };
    } catch { /* 落回默认 */ }
  }
  return { ...DEFAULTS };
}

export function isMockMode(s = getAISettings()) {
  return s.provider !== 'openai' || !s.baseUrl;
}

function modelFor(task, s) {
  const m = s.models?.[task] || s.models?.writer || s.models?.planner || '';
  return m || (isMockMode(s) ? 'mock-1' : '');
}

function estimateTokens(text) {
  return Math.round(String(text || '').length / 1.7);
}

function logCall({ projectId, chapterId, step, model, text, usage, status, error, durationMs }) {
  try {
    run(
      `INSERT INTO ai_calls (project_id, chapter_id, step, model, input_tokens, output_tokens, cached_tokens, estimated, status, error, duration_ms, summary, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      projectId ?? null,
      chapterId ?? null,
      step,
      model || 'unknown',
      usage?.input_tokens || 0,
      usage?.output_tokens || 0,
      usage?.cached_tokens || 0,
      usage?.estimated ? 1 : 0,
      status,
      error ? String(error).slice(0, 500) : null,
      durationMs || 0,
      status === 'ok'
        ? `${step} · ${countWords(text)}字${usage?.estimated ? ' · 用量为估算' : ''}`
        : `${step} 失败`,
      now()
    );
  } catch { /* 记录失败不影响主流程 */ }
}

/** 把完整文本切成小块，模拟流式节奏 */
function* chunkStream(text) {
  const size = 24 + Math.floor(Math.random() * 40);
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (buf.length >= size) {
      yield buf;
      buf = '';
    }
  }
  if (buf) yield buf;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OpenAI 兼容流式调用 */
async function chatCompletion(s, model, call) {
  const url = s.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const messages = [
    { role: 'system', content: call.system },
    { role: 'user', content: call.user },
  ];
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: call.temperature ?? 0.85,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify(body),
    signal: call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型接口错误 HTTP ${res.status}：${t.slice(0, 300)}`);
  }
  let text = '';
  let usage = null;
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          call.onDelta?.(delta);
        }
        if (j.usage) {
          usage = {
            input_tokens: j.usage.prompt_tokens || 0,
            output_tokens: j.usage.completion_tokens || 0,
            cached_tokens: j.usage.prompt_tokens_details?.cached_tokens || 0,
          };
        }
      } catch { /* 忽略无法解析的心跳行 */ }
    }
  }
  if (!usage) {
    usage = {
      input_tokens: estimateTokens(call.system) + estimateTokens(call.user),
      output_tokens: estimateTokens(text),
      cached_tokens: 0,
      estimated: true,
    };
  }
  return { text, usage };
}

/**
 * 统一调用入口。
 * call: { task, step, system, user, projectId, chapterId, temperature, stream, onDelta, mock }
 * mock: () => string —— mock 模式下由调用方提供演示文本生成器
 */
export async function callAI(call) {
  const s = getAISettings();
  const model = modelFor(call.task, s);
  const mock = isMockMode(s);
  if (!mock && !model) {
    throw new Error('尚未配置模型：请在「模型设置」中填写模型名称（可为规划/正文/审阅分别指定）');
  }
  /* 项目级提示词模板覆盖（系统提示词替换 / 用户提示词追加） */
  if (call.projectId && call.step) {
    const t = applyTemplate(call.step, call.projectId, { system: call.system || '', user: call.user || '' });
    call = { ...call, system: t.system, user: t.user };
  }
  const t0 = Date.now();
  try {
    let text = '';
    let usage = null;
    if (mock) {
      text = call.mock ? String(call.mock()) : '（Mock 模式：该步骤未提供演示内容）';
      if (call.stream && call.onDelta) {
        for (const piece of chunkStream(text)) {
          call.onDelta(piece);
          await sleep(14);
        }
      }
      usage = {
        input_tokens: estimateTokens(call.system) + estimateTokens(call.user),
        output_tokens: estimateTokens(text),
        cached_tokens: 0,
        estimated: true,
      };
    } else {
      const out = await chatCompletion(s, model, call);
      text = out.text;
      usage = out.usage;
    }
    logCall({ ...call, model: mock ? 'mock-1' : model, text, usage, status: 'ok', durationMs: Date.now() - t0 });
    return { text, usage, model: mock ? 'mock-1' : model };
  } catch (e) {
    logCall({ ...call, model: mock ? 'mock-1' : model, text: '', usage: null, status: 'error', error: e?.message || String(e), durationMs: Date.now() - t0 });
    throw e;
  }
}

/** 连接测试：可用传入配置测试，不落库 */
export async function testConnection(override = {}) {
  const saved = getAISettings();
  const s = {
    provider: override.provider || saved.provider,
    baseUrl: override.baseUrl || saved.baseUrl,
    apiKey: override.apiKey || saved.apiKey,
  };
  const model = override.model || saved.models.planner || saved.models.writer;
  if (s.provider !== 'openai' || !s.baseUrl) {
    return { ok: true, mock: true, reply: 'Mock 演示模式运行中，无需外部连接。' };
  }
  if (!model) return { ok: false, error: '请先填写要测试的模型名称' };
  const t0 = Date.now();
  try {
    const url = s.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是连接测试助手。' },
          { role: 'user', content: '请只回复四个字：连接成功' },
        ],
        max_tokens: 20,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}：${t.slice(0, 300)}` };
    }
    const j = await res.json();
    return {
      ok: true,
      model,
      reply: j.choices?.[0]?.message?.content?.trim().slice(0, 50) || '（空回复）',
      usage: j.usage
        ? { input_tokens: j.usage.prompt_tokens || 0, output_tokens: j.usage.completion_tokens || 0 }
        : null,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
