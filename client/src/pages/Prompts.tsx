import { useEffect, useState } from 'react';
import { api, fmtTime } from '../api';
import { useProject } from './ProjectPage';
import { Badge, ErrorNote } from '../components/ui';
import type { PromptTemplate, PromptTemplateVersion } from '../types';

export default function Prompts() {
  const { project } = useProject();
  const [items, setItems] = useState<PromptTemplate[]>([]);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [draft, setDraft] = useState({ system: '', suffix: '' });
  const [history, setHistory] = useState<PromptTemplateVersion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setItems(await api.get(`/projects/${project.id}/prompt-templates`));
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => { load(); }, [project.id]);

  const loadHistory = async (step: string) => {
    try {
      setHistory(await api.get(`/projects/${project.id}/prompt-templates/${step}/history`));
    } catch {
      setHistory([]);
    }
  };

  const open = async (t: PromptTemplate) => {
    if (openStep === t.step) {
      setOpenStep(null);
      return;
    }
    setOpenStep(t.step);
    setDraft({ system: t.system || '', suffix: t.suffix || '' });
    setNote(null);
    await loadHistory(t.step);
  };

  const save = async (step: string) => {
    setBusy(true); setErr(null); setNote(null);
    try {
      await api.put(`/projects/${project.id}/prompt-templates/${step}`, draft);
      await load();
      await loadHistory(step);
      setNote('已保存本书覆盖，下一次生成即生效');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (step: string) => {
    setBusy(true); setErr(null); setNote(null);
    try {
      await api.del(`/projects/${project.id}/prompt-templates/${step}`);
      await load();
      await loadHistory(step);
      setDraft({ system: '', suffix: '' });
      setNote('已恢复默认提示词');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (step: string, historyId: number) => {
    setBusy(true); setErr(null); setNote(null);
    try {
      await api.post(`/projects/${project.id}/prompt-templates/${step}/rollback`, { historyId });
      await load();
      await loadHistory(step);
      setNote('已回滚到选定版本');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="hint-box" style={{ marginBottom: 16 }}>
        提示词模板按步骤覆盖，只影响本书。<b>系统提示词留空</b>即使用内置版本；<b>补充要求</b>会追加到该步骤用户提示词末尾。
        保存前会自动留档，可随时回滚。
      </div>

      {note && <div className="hint-box" style={{ marginBottom: 16 }}>{note}</div>}
      <ErrorNote error={err} onRetry={load} />

      <div className="stack">
        {items.map((t) => (
          <div key={t.step} className="card">
            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <div className="row-wrap">
                <b>{t.label}</b>
                <span className="muted small">{t.desc}</span>
                {t.overridden && <Badge tone="accent">本书已覆盖</Badge>}
                {t.global && <Badge tone="info">继承全局</Badge>}
                {!t.overridden && !t.global && <Badge>默认</Badge>}
                {t.updated_at && <span className="muted small">{fmtTime(t.updated_at)}</span>}
              </div>
              <button className="btn ghost small" onClick={() => open(t)}>{openStep === t.step ? '收起' : '编辑'}</button>
            </div>

            {openStep === t.step && (
              <div className="mt16">
                <label className="field">
                  <span className="field-label">系统提示词 <em className="field-hint">留空 = 使用内置；填写将整体替换</em></span>
                  <textarea
                    value={draft.system}
                    style={{ minHeight: 110 }}
                    placeholder="例如：你是一位擅长冷硬派悬疑的中文小说作者……"
                    onChange={(e) => setDraft({ ...draft, system: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">补充要求 <em className="field-hint">追加到用户提示词末尾，适合写本书专属约束</em></span>
                  <textarea
                    value={draft.suffix}
                    style={{ minHeight: 90 }}
                    placeholder="例如：对白尽量短，避免连续两句以上不超过十个字的陈述；每章至少出现一次具体的气味描写。"
                    onChange={(e) => setDraft({ ...draft, suffix: e.target.value })}
                  />
                </label>
                <div className="row">
                  <button className="btn primary small" disabled={busy} onClick={() => save(t.step)}>保存覆盖</button>
                  {(t.overridden || t.system || t.suffix) && (
                    <button className="btn small" disabled={busy} onClick={() => reset(t.step)}>恢复默认</button>
                  )}
                </div>

                {history.length > 0 && (
                  <div className="mt16">
                    <div className="muted small">历史版本（最近 {history.length} 条）</div>
                    <div className="stack mt8">
                      {history.map((h) => (
                        <div key={h.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                          <span className="small muted">
                            {fmtTime(h.created_at)} · 系统 {h.system ? `${h.system.length} 字` : '空'} · 补充 {h.suffix ? `${h.suffix.length} 字` : '空'}
                          </span>
                          <button className="btn ghost small" disabled={busy} onClick={() => rollback(t.step, h.id)}>回滚到此版本</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
