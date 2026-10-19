import { useEffect, useState } from 'react';
import { api, fmtTime, fmtTokens, STEP_NAMES } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Spinner, ErrorNote } from '../components/ui';
import type { UsageData } from '../types';

export default function Usage() {
  const { project } = useProject();
  const [data, setData] = useState<UsageData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.get(`/usage?projectId=${project.id}`).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [project.id]);

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <span className="muted small">总 Tokens = 输入 + 输出；缓存命中属于输入，不重复相加。用量为调用计数，实际费用以模型厂商账单为准。</span>
      </div>
      <ErrorNote error={err} onRetry={load} />
      {!data ? (
        <div className="loading-block"><Spinner /></div>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-num">{data.totals.calls}</div>
              <div className="stat-label">调用次数（{data.totals.errors || 0} 次失败）</div>
            </div>
            <div className="stat">
              <div className="stat-num">{fmtTokens(data.totals.input_tokens)}<em>in</em></div>
              <div className="stat-label">输入 Tokens{data.totals.estimated > 0 ? ` · ${data.totals.estimated} 次为估算` : ''}</div>
            </div>
            <div className="stat">
              <div className="stat-num">{fmtTokens(data.totals.output_tokens)}<em>out</em></div>
              <div className="stat-label">输出 Tokens</div>
            </div>
            <div className="stat">
              <div className="stat-num">{fmtTokens(data.totals.cached_tokens)}<em>cached</em></div>
              <div className="stat-label">缓存命中（厂商报告）</div>
            </div>
          </div>

          <div className="grid grid-2 mt16">
            <div className="card">
              <div className="card-title">按步骤</div>
              <table className="table">
                <thead><tr><th>步骤</th><th style={{ width: 60 }}>次数</th><th style={{ width: 90 }}>输入</th><th style={{ width: 90 }}>输出</th></tr></thead>
                <tbody>
                  {data.byStep.map((s) => (
                    <tr key={s.step}>
                      <td>{STEP_NAMES[s.step] || s.step}</td>
                      <td className="muted">{s.calls}</td>
                      <td className="muted">{fmtTokens(s.input_tokens)}</td>
                      <td className="muted">{fmtTokens(s.output_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="card-title">按模型</div>
              <table className="table">
                <thead><tr><th>模型</th><th style={{ width: 60 }}>次数</th><th style={{ width: 90 }}>输入</th><th style={{ width: 90 }}>输出</th></tr></thead>
                <tbody>
                  {data.byModel.map((m) => (
                    <tr key={m.model}>
                      <td>{m.model}</td>
                      <td className="muted">{m.calls}</td>
                      <td className="muted">{fmtTokens(m.input_tokens)}</td>
                      <td className="muted">{fmtTokens(m.output_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card mt16">
            <div className="card-title">运行记录（最近 500 次）</div>
            <table className="table">
              <thead>
                <tr><th style={{ width: 110 }}>时间</th><th style={{ width: 100 }}>步骤</th><th style={{ width: 130 }}>模型</th><th style={{ width: 70 }}>输入</th><th style={{ width: 70 }}>输出</th><th style={{ width: 80 }}>状态</th><th>摘要</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{fmtTime(r.created_at)}</td>
                    <td>{STEP_NAMES[r.step] || r.step}</td>
                    <td className="muted">{r.model}</td>
                    <td className="muted">{fmtTokens(r.input_tokens)}</td>
                    <td className="muted">{fmtTokens(r.output_tokens)}</td>
                    <td>{r.status === 'ok' ? <Badge tone="ok">成功</Badge> : <Badge tone="accent">失败</Badge>}</td>
                    <td className="muted small" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.error || r.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
