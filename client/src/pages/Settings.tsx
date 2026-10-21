import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote, Spinner } from '../components/ui';
import type { AISettings } from '../types';

/** 常用 OpenAI 兼容服务及其可选模型；最后一个「自定义」允许手填地址与模型 */
const VENDORS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'] },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
  { name: '通义 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'] },
  { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1'] },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'] },
];
const CUSTOM = '自定义';

/** Anthropic Claude 官方 Messages API（非 OpenAI 协议，服务端单独适配） */
const CLAUDE = {
  name: 'Anthropic Claude',
  baseUrl: 'https://api.anthropic.com/v1',
  models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
};

export default function Settings() {
  const [s, setS] = useState<AISettings | null>(null);
  const [tab, setTab] = useState<'model' | 'data'>('model');
  const [vendor, setVendor] = useState(CUSTOM);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelMsg, setModelMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    api.get('/settings').then((r) => {
      setS(r.ai);
      const matched = VENDORS.find((v) => v.baseUrl === r.ai.baseUrl);
      setVendor(matched ? matched.name : CUSTOM);
    }).catch((e) => setErr(e.message));
  }, []);

  if (!s) {
    return (
      <main className="page">
        <ErrorNote error={err} />
        <div className="loading-block"><Spinner text="读取设置…" /></div>
      </main>
    );
  }

  const save = async () => {
    setSaving(true); setErr(null); setTestResult(null);
    try {
      const r = await api.put('/settings', s);
      setS(r.ai);
      setSavedAt(Date.now());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true); setTestResult(null); setErr(null);
    try {
      const body: any = {
        provider: s.provider,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.models.planner || s.models.writer,
      };
      const r = await api.post('/settings/test', body);
      setTestResult({ ok: r.ok, text: r.ok ? `连接成功${r.mock ? '（Mock 演示模式，无需外部连接）' : ` · ${r.model} · ${r.reply}`}（${r.durationMs ?? 0}ms）` : r.error });
    } catch (e: any) {
      setTestResult({ ok: false, text: e.message });
    } finally {
      setTesting(false);
    }
  };

  const vendorModels = remoteModels.length
    ? remoteModels
    : (s.provider === 'anthropic' ? CLAUDE.models : VENDORS.find((v) => v.name === vendor)?.models || []);

  /** 切换接入方式：Claude 直连与 OpenAI 兼容接口的地址、模型互不串用 */
  const changeProvider = (provider: AISettings['provider']) => {
    if (provider === s.provider) return;
    setTestResult(null);
    setRemoteModels([]);
    setModelMsg(null);
    if (provider === 'anthropic') {
      setVendor(CUSTOM);
      setS({ ...s, provider, baseUrl: CLAUDE.baseUrl, models: { planner: CLAUDE.models[0], writer: CLAUDE.models[0], reviewer: CLAUDE.models[0] } });
      return;
    }
    if (provider === 'openai' && s.baseUrl.startsWith(CLAUDE.baseUrl)) {
      setVendor(CUSTOM);
      setS({ ...s, provider, baseUrl: '', models: { planner: '', writer: '', reviewer: '' } });
      return;
    }
    setS({ ...s, provider });
  };

  /** 切换服务商：同步接口地址，并把三个任务模型重置为该服务的默认模型 */
  const changeVendor = (name: string) => {
    setVendor(name);
    setRemoteModels([]);
    setModelMsg(null);
    const v = VENDORS.find((x) => x.name === name);
    if (!v) return;
    setS({ ...s, baseUrl: v.baseUrl, models: { planner: v.models[0], writer: v.models[0], reviewer: v.models[0] } });
  };

  const setModel = (key: 'planner' | 'writer' | 'reviewer', value: string) =>
    setS({ ...s, models: { ...s.models, [key]: value } });

  /** 从服务商拉取真实模型列表，失败时仍可手动填写 */
  const fetchModels = async () => {
    setLoadingModels(true); setModelMsg(null);
    try {
      const r = await api.post('/settings/models', { provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey });
      const list = Array.isArray(r.models) ? r.models : [];
      setRemoteModels(list);
      setModelMsg(list.length ? `已获取 ${list.length} 个模型，可在下拉中选择。` : '接口未返回模型列表，可直接手填模型名。');
    } catch (e: any) {
      setModelMsg(e.message || '获取失败，可直接手填模型名');
    } finally {
      setLoadingModels(false);
    }
  };

  /** 一行模型分配：角色 → 用途 → 实际请求模型；没有模型列表时直接手填 */
  const modelRow = (key: 'planner' | 'writer' | 'reviewer', glyph: string, name: string, use: string) => {
    const value = s.models[key] || '';
    const custom = !vendorModels.includes(value);
    const placeholder = s.provider === 'anthropic' ? '输入模型名，如 claude-sonnet-5-5' : '输入模型名，如 deepseek-chat';
    return (
      <div className="model-item" key={key}>
        <span className={`model-glyph g-${key}`} aria-hidden="true">{glyph}</span>
        <div className="model-meta">
          <div className="model-name">{name}</div>
          <div className="model-use">{use}</div>
        </div>
        <div className={`model-picker ${vendorModels.length && custom ? 'custom' : ''}`}>
          {vendorModels.length > 0 && (
            <select
              aria-label={`${name}的实际请求模型`}
              value={custom ? '__custom' : value}
              onChange={(e) => setModel(key, e.target.value === '__custom' ? '' : e.target.value)}
            >
              {vendorModels.map((m) => <option key={m} value={m}>{m}</option>)}
              <option value="__custom">自定义模型…</option>
            </select>
          )}
          {(custom || !vendorModels.length) && (
            <input
              type="text"
              placeholder={placeholder}
              aria-label={`${name}的模型名`}
              value={value}
              onChange={(e) => setModel(key, e.target.value)}
            />
          )}
        </div>
      </div>
    );
  };

  /** 一键设置：把规划模型的当前选择同步到正文与审阅 */
  const applyFromPlanner = () => {
    const m = (s.models.planner || '').trim();
    if (!m) return;
    setS({ ...s, models: { planner: m, writer: m, reviewer: m } });
    setModelMsg(`已将三个任务统一为 ${m}`);
  };

  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <div className="sub">模型接入与本地数据说明，所有配置只保存在本机。</div>
        </div>
        <Link to="/" className="btn">← 返回书架</Link>
      </div>

      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={tab === 'model' ? 'on' : ''} onClick={() => setTab('model')}>AI 模型</button>
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>数据与隐私</button>
      </div>

      {tab === 'model' && (
        <>
          <div className="card">
            <div className="card-title">供应商</div>
            <div className="radio-row">
              <div className={`radio-card ${s.provider === 'mock' ? 'on' : ''}`} onClick={() => changeProvider('mock')}>
                <div className="radio-title">Mock 演示模式</div>
                <div className="radio-desc">无需 API Key，内置演示引擎跑通全部流程</div>
              </div>
              <div className={`radio-card ${s.provider === 'openai' ? 'on' : ''}`} onClick={() => changeProvider('openai')}>
                <div className="radio-title">OpenAI 兼容接口</div>
                <div className="radio-desc">DeepSeek / Kimi / GLM / Qwen / OpenAI 等</div>
              </div>
              <div className={`radio-card ${s.provider === 'anthropic' ? 'on' : ''}`} onClick={() => changeProvider('anthropic')}>
                <div className="radio-title">{CLAUDE.name}</div>
                <div className="radio-desc">官方 Messages API 直连，Opus / Sonnet / Haiku</div>
              </div>
            </div>
            {s.provider === 'mock' && (
              <div className="hint-box" style={{ marginTop: 16 }}>
                Mock 演示模式下，所有 AI 步骤由内置演示引擎生成结构化示例内容（正文会标注「Mock 演示」），
                用于零成本体验「方向 → 世界 → 角色 → 卷纲 → 拆章 → 正文 → 检查 → 同步」的完整创作链。
                接入真实模型后即可正式创作。
              </div>
            )}
          </div>

          {s.provider !== 'mock' && (
            <>
              <div className="card mt16">
                <div className="card-title">接口</div>
                {s.provider === 'openai' ? (
                  <div className="setting-row">
                    <span className="setting-label">服务商</span>
                    <select value={vendor} onChange={(e) => changeVendor(e.target.value)}>
                      {VENDORS.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                      <option value={CUSTOM}>自定义（手动填写地址与模型）</option>
                    </select>
                  </div>
                ) : (
                  <div className="setting-row">
                    <span className="setting-label">服务商</span>
                    <div className="setting-static">
                      {CLAUDE.name}
                      <span className="badge badge-info">Messages API</span>
                    </div>
                  </div>
                )}
                <div className="setting-row">
                  <span className="setting-label">API 地址</span>
                  <input type="text" placeholder="https://api.example.com/v1" value={s.baseUrl}
                    onChange={(e) => setS({ ...s, baseUrl: e.target.value })} />
                </div>
                <div className="setting-row" style={{ marginBottom: 0 }}>
                  <span className="setting-label">API Key</span>
                  <input type="password" placeholder="sk-…" value={s.apiKey}
                    onChange={(e) => setS({ ...s, apiKey: e.target.value })} />
                </div>
                {s.provider === 'anthropic' && (
                  <div className="hint-box" style={{ marginTop: 14 }}>
                    Key 在 Anthropic 控制台创建，按 tokens 计费；官方接口与 OpenAI 协议不同，这里已直接适配 Messages API。
                    若走中转 / 聚合网关，请改选「OpenAI 兼容接口」并手填地址与模型名。
                  </div>
                )}
              </div>

              <div className="card mt16">
                <div className="model-card-head">
                  <div>
                    <div className="card-title">模型分配</div>
                    <div className="model-sub">按任务挑模型：贵的写正文，便宜的做规划与审阅。</div>
                  </div>
                  <button className="btn small" onClick={fetchModels} disabled={loadingModels}
                    title="从当前服务商拉取可用模型">
                    {loadingModels ? <Spinner /> : '↻ 获取模型列表'}
                  </button>
                </div>
                <div className="model-list">
                  {modelRow('planner', '规', '规划模型', '方向 / 世界 / 角色 / 卷纲')}
                  {modelRow('writer', '写', '正文模型', '整章生成 / 续写 / 改写')}
                  {modelRow('reviewer', '审', '审阅模型', '章节检查 / 状态同步')}
                </div>
                <div className="model-foot">
                  <span className="model-hint">
                    {vendorModels.length
                      ? '下拉里没有的模型，选「自定义模型…」手动填写。'
                      : '当前服务商没有模型列表，可直接填写模型名，或点右上角拉取列表。'}
                  </span>
                  <button className="btn small" onClick={applyFromPlanner}
                    disabled={!s.models.planner.trim()} title="把规划模型的当前选择同步到正文与审阅">
                    统一为规划模型
                  </button>
                </div>
                {modelMsg && <div className="model-msg">{modelMsg}</div>}
              </div>
            </>
          )}

          <div className="row mt16" style={{ justifyContent: 'flex-end' }}>
            {savedAt && !err ? <span className="muted small" style={{ color: 'var(--ok)' }}>已保存 ✓</span> : null}
            <button className="btn" disabled={testing || saving} onClick={test}>{testing ? <Spinner /> : '测试连接'}</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? <Spinner /> : '保存设置'}</button>
          </div>
          {testResult && (
            <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.ok ? '✓ ' : '✕ '}{testResult.text}</div>
          )}
          <ErrorNote error={err} />
        </>
      )}

      {tab === 'data' && (
        <div className="card">
          <div className="card-title">数据与隐私</div>
          <div className="kv" style={{ lineHeight: 2 }}>
            <div><b>存储</b>全部作品与配置保存在本机 SQLite：<code>server/data/novelwriter.db</code></div>
            <div><b>备份</b>直接复制该文件即可完整备份；也可在本书页导出 Markdown / TXT / DOCX / EPUB</div>
            <div><b>调用</b>仅在生成时直连你配置的模型服务；平台自身没有账号体系，也不中转任何数据</div>
            <div><b>日志</b>AI 调用记录只保留提示词摘要与用量，用于本书的用量统计，可在书内查看</div>
          </div>
        </div>
      )}
    </main>
  );
}
