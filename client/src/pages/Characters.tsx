import { useState } from 'react';
import { api } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Modal, Field, Spinner, ErrorNote, Empty, ConfirmButton } from '../components/ui';
import type { Character, Relation } from '../types';

const ROLES = ['主角', '重要配角', '配角', '反派'];
const ROLE_TONE: Record<string, 'accent' | 'info' | 'default' | 'warn'> = { 主角: 'accent', 重要配角: 'info', 配角: 'default', 反派: 'warn' };

export default function Characters() {
  const { project, reload } = useProject();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Character> | null>(null);
  const [relEditing, setRelEditing] = useState(false);
  const [rel, setRel] = useState<Partial<Relation>>({ type: '关系' });

  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/projects/${project.id}/characters/generate`);
      await reload();
      if (r.added === 0) setErr('AI 返回的角色都与现有角色重名，未新增。可先删除或改名后再试。');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setErr('角色名不能为空'); return; }
    try {
      if (editing.id) await api.put(`/projects/${project.id}/characters/${editing.id}`, editing);
      else await api.post(`/projects/${project.id}/characters`, editing);
      setEditing(null);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const saveRel = async () => {
    if (!rel.from_name || !rel.to_name) { setErr('关系需要双方角色名'); return; }
    try {
      await api.post(`/projects/${project.id}/relations`, rel);
      setRelEditing(false);
      setRel({ type: '关系' });
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <span className="muted small">「当前状态」会随章节写作自动同步 —— 它是 AI 写下一章时的人物记忆。</span>
        <span className="grow" />
        <button className="btn" onClick={() => { setRelEditing(true); setErr(null); }}>＋ 新增关系</button>
        <button className="btn" onClick={() => setEditing({ role: '配角' })}>＋ 手动新增角色</button>
        <button className="btn primary" disabled={busy} onClick={generate}>{busy ? <><Spinner /> AI 设计中…</> : 'AI 起草角色'}</button>
      </div>
      <ErrorNote error={err} />

      {project.characters.length === 0 && !busy ? (
        <Empty title="还没有人物" desc="让 AI 设计主角、重要配角与反派：每个人都有核心欲望、致命缺陷与主线的绑定方式，反派逻辑自洽。" />
      ) : (
        <div className="grid grid-2">
          {project.characters.map((c) => (
            <div key={c.id} className="card" style={{ padding: '16px 18px' }}>
              <div className="row">
                <span style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{c.name}</span>
                <Badge tone={ROLE_TONE[c.role] || 'default'}>{c.role}</Badge>
                <span className="grow" />
                <button className="btn ghost small" onClick={() => setEditing(c)}>编辑</button>
                <ConfirmButton
                  className="btn ghost small"
                  onConfirm={async () => { await api.del(`/projects/${project.id}/characters/${c.id}`); await reload(); }}
                >
                  删除
                </ConfirmButton>
              </div>
              <p className="muted mt8" style={{ lineHeight: 1.8, fontSize: 13 }}>{c.profile}</p>
              <div className="kv mt8">
                {c.goals ? <div><b>目标</b>{c.goals}</div> : null}
                {c.appearance ? <div><b>外貌</b>{c.appearance}</div> : null}
              </div>
              {c.status ? (
                <div className="mt8" style={{ background: 'var(--warn-soft)', border: '1px solid #e8d9b0', color: 'var(--warn)', borderRadius: 7, padding: '7px 10px', fontSize: 12.5, lineHeight: 1.7 }}>
                  当前状态 · {c.status}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {project.relations.length > 0 && (
        <div className="card mt16">
          <div className="card-title">关系网</div>
          {project.relations.map((r) => (
            <div key={r.id} className="rel-row">
              <b>{r.from_name}</b>
              <span className="rel-arrow">─【{r.type}】→</span>
              <b>{r.to_name}</b>
              <span className="muted grow">{r.description}</span>
              <ConfirmButton
                className="btn ghost small"
                onConfirm={async () => { await api.del(`/projects/${project.id}/relations/${r.id}`); await reload(); }}
              >
                删除
              </ConfirmButton>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? `编辑角色 · ${editing.name}` : '新增角色'} onClose={() => setEditing(null)}>
          <div className="grid grid-2">
            <Field label="姓名"><input type="text" value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="定位">
              <select value={editing.role || '配角'} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                {ROLES.map((r) => <option key={r}>{r}</option>)}
              </select>
            </Field>
          </div>
          <Field label="性格与背景"><textarea rows={3} value={editing.profile || ''} onChange={(e) => setEditing({ ...editing, profile: e.target.value })} /></Field>
          <Field label="核心目标与动机"><textarea rows={2} value={editing.goals || ''} onChange={(e) => setEditing({ ...editing, goals: e.target.value })} /></Field>
          <Field label="外貌特征"><input type="text" value={editing.appearance || ''} onChange={(e) => setEditing({ ...editing, appearance: e.target.value })} /></Field>
          <Field label="当前状态" hint="写作同步的目标字段，也可手填">
            <input type="text" value={editing.status || ''} onChange={(e) => setEditing({ ...editing, status: e.target.value })} />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary" onClick={save}>保存</button>
          </div>
        </Modal>
      )}

      {relEditing && (
        <Modal title="新增关系" onClose={() => setRelEditing(false)}>
          <div className="grid grid-2">
            <Field label="角色 A">
              <select value={rel.from_name || ''} onChange={(e) => setRel({ ...rel, from_name: e.target.value })}>
                <option value="">选择…</option>
                {project.characters.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="角色 B">
              <select value={rel.to_name || ''} onChange={(e) => setRel({ ...rel, to_name: e.target.value })}>
                <option value="">选择…</option>
                {project.characters.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="关系类型"><input type="text" value={rel.type || ''} onChange={(e) => setRel({ ...rel, type: e.target.value })} placeholder="例：相互亏欠的盟友 / 立场对立" /></Field>
          <Field label="一句话说明"><input type="text" value={rel.description || ''} onChange={(e) => setRel({ ...rel, description: e.target.value })} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setRelEditing(false)}>取消</button>
            <button className="btn primary" onClick={saveRel}>保存</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
