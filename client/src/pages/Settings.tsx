import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Field, ErrorNote, Spinner, Badge } from '../components/ui';
import type { AISettings } from '../types';

export default function Settings() {
  const [s, setS] = useState<AISettings | null>(null);
  const [sameModel, setSameModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    api.get('/settings').then((r) => setS(r.ai)).catch((e) => setErr(e.message));
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

  const applySameModel = () => {
    if (!sameModel.trim()) return;
    setS({ ...s, models: { planner: sameModel.trim(), writer: sameModel.trim(), reviewer: sameModel.trim() } });
  };

  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div>
          <h1>模型设置</h1>
          <div className="sub">API Key 只保存在本机数据库（server/data/），不会上传到任何第三方。</div>
        </div>
        <Link to="/" className="btn">← 返回书架</Link>
      </div>

      <div className="card">
        <div className="card-title">供应商</div>
        <div className="radio-row" style={{ marginBottom: 16 }}>
          <div className={`radio-card ${s.provider === 'mock' ? 'on' : ''}`} onClick={() => setS({ ...s, provider: 'mock' })}>
            <div className="radio-title">Mock 演示模式</div>
            <div className="radio-desc">无需 API Key，内置演示引擎跑通全部流程</div>
          </div>
          <div className={`radio-card ${s.provider === 'openai' ? 'on' : ''}`} onClick={() => setS({ ...s, provider: 'openai' })}>
            <div className="radio-title">OpenAI 兼容接口</div>
            <div className="radio-desc">DeepSeek / Kimi / GLM / Qwen / OpenAI 等</div>
          </div>
        </div>

        {s.provider === 'openai' && (
          <>
            <div className="setting-row">
              <span className="setting-label">API 地址</span>
              <input type="text" placeholder="https://api.deepseek.com/v1" value={s.baseUrl}
                onChange={(e) => setS({ ...s, baseUrl: e.target.value })} />
            </div>
            <div className="setting-row">
              <span className="setting-label">API Key</span>
              <input type="password" placeholder="sk-…" value={s.apiKey}
                onChange={(e) => setS({ ...s, apiKey: e.target.value })} />
            </div>
            <div className="setting-row">
              <span className="setting-label">统一模型</span>
              <span className="row">
                <input type="text" placeholder="例：deepseek-chat" value={sameModel} onChange={(e) => setSameModel(e.target.value)} />
                <button className="btn small" onClick={applySameModel}>应用到全部任务</button>
              </span>
            </div>
            <div className="setting-row">
              <span className="setting-label">规划模型</span>
              <input type="text" placeholder="方向 / 世界 / 角色 / 卷纲 / 拆章" value={s.models.planner}
                onChange={(e) => setS({ ...s, models: { ...s.models, planner: e.target.value } })} />
            </div>
            <div className="setting-row">
              <span className="setting-label">正文模型</span>
              <input type="text" placeholder="整章生成 / 续写 / 改写" value={s.models.writer}
                onChange={(e) => setS({ ...s, models: { ...s.models, writer: e.target.value } })} />
            </div>
            <div className="setting-row">
              <span className="setting-label">审阅模型</span>
              <input type="text" placeholder="章节检查 / 状态同步" value={s.models.reviewer}
                onChange={(e) => setS({ ...s, models: { ...s.models, reviewer: e.target.value } })} />
            </div>
            <div className="hint-box">
              也可以为不同任务指定不同模型：便宜的模型做规划与审阅，强模型写正文。留空的模型会回退到其他已配置的模型。
            </div>
          </>
        )}

        {s.provider === 'mock' && (
          <div className="hint-box">
            Mock 演示模式下，所有 AI 步骤由内置演示引擎生成结构化示例内容（正文会标注「Mock 演示」），
            用于零成本体验「方向 → 世界 → 角色 → 卷纲 → 拆章 → 正文 → 检查 → 同步」的完整创作链。
            接入真实模型后即可正式创作。
          </div>
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
      </div>

      <div className="card mt16">
        <div className="card-title">数据与隐私</div>
        <div className="kv" style={{ lineHeight: 2 }}>
          <div><b>存储</b>全部数据保存在本机 SQLite：<code>server/data/novelwriter.db</code></div>
          <div><b>调用</b>仅在生成时直连你配置的模型服务；平台自身没有任何服务端账号体系</div>
          <div><b>导出</b>每本书可随时导出 Markdown / TXT（见本书页右上角）</div>
        </div>
      </div>
    </main>
  );
}
