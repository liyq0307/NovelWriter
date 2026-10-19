import { useState } from 'react';
import { api } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Modal, Field, Spinner, ErrorNote, Empty, ConfirmButton } from '../components/ui';
import type { WorldEntry } from '../types';

const CATS = ['地理', '势力', '规则', '物品', '历史', '其他'];
const CAT_GLYPH: Record<string, string> = { 地理: '山', 势力: '旗', 规则: '律', 物品: '器', 历史: '卷', 其他: '杂' };

export default function World() {
  const { project, reload } = useProject();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<WorldEntry> | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const grouped = CATS.map((c) => ({ cat: c, items: project.world.filter((w) => w.category === c) }))
    .filter((g) => g.items.length > 0);

  const generate = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await api.post(`/projects/${project.id}/world/generate`);
      await reload();
      setNote(`AI 新增了 ${r.added} 条设定（已自动跳过与现有条目重名的内容）。`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setErr('条目名不能为空'); return; }
    try {
      if (editing.id) {
        await api.put(`/projects/${project.id}/world/${editing.id}`, editing);
      } else {
        await api.post(`/projects/${project.id}/world`, editing);
      }
      setEditing(null);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <span className="muted small">世界手册里的每一条设定，都会注入正文生成的上下文 —— 规则明确，AI 才不越界。</span>
        <span className="grow" />
        <button className="btn" onClick={() => setEditing({ category: '其他' })}>＋ 手动新增</button>
        <button className="btn primary" disabled={busy} onClick={generate}>{busy ? <><Spinner /> AI 起草中…</> : 'AI 起草设定'}</button>
      </div>
      {note && <div className="hint-box" style={{ marginBottom: 14 }}>{note}</div>}
      <ErrorNote error={err} />

      {grouped.length === 0 && !busy ? (
        <Empty title="世界还是一片空白" desc="让 AI 基于已定方向起草：地理舞台、势力立场、世界规则（含能力边界与代价）、关键物品与历史暗线。" />
      ) : (
        grouped.map((g) => (
          <div key={g.cat} className="mt16">
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 600 }}>
                <span style={{
                  display: 'inline-flex', width: 24, height: 24, borderRadius: 6, background: 'var(--sidebar)',
                  color: '#d8b98a', alignItems: 'center', justifyContent: 'center', fontSize: 12, marginRight: 8, verticalAlign: 'middle',
                }}>{CAT_GLYPH[g.cat]}</span>
                {g.cat}
              </span>
              <span className="muted small">{g.items.length} 条</span>
            </div>
            <div className="grid grid-2">
              {g.items.map((w) => (
                <div key={w.id} className="card" style={{ padding: '14px 16px' }}>
                  <div className="row">
                    <b style={{ fontSize: 14.5 }}>{w.name}</b>
                    {w.source === 'human' ? <Badge tone="info">手写</Badge> : <Badge>AI</Badge>}
                    <span className="grow" />
                    <button className="btn ghost small" onClick={() => setEditing(w)}>编辑</button>
                    <ConfirmButton
                      className="btn ghost small"
                      onConfirm={async () => { await api.del(`/projects/${project.id}/world/${w.id}`); await reload(); }}
                    >
                      删除
                    </ConfirmButton>
                  </div>
                  <p className="muted mt8" style={{ lineHeight: 1.8, fontSize: 13 }}>{w.content}</p>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {editing && (
        <Modal title={editing.id ? '编辑设定条目' : '新增设定条目'} onClose={() => setEditing(null)}>
          <Field label="分类">
            <select value={editing.category || '其他'} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
              {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="条目名">
            <input type="text" value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例：临渊城 / 守夜人司 / 回响" />
          </Field>
          <Field label="设定内容" hint="要具体到能直接约束正文写作">
            <textarea rows={5} value={editing.content || ''} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary" onClick={save}>保存</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
