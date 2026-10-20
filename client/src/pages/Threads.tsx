import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, cnNum, THREAD_KINDS, THREAD_STATUS_NAMES, THREAD_STATUS_TONE } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Modal, Field, Spinner, ErrorNote, Empty, ConfirmButton } from '../components/ui';
import type { Thread } from '../types';

type Filter = 'open' | 'resolved' | 'all';

export default function Threads() {
  const { project, reload } = useProject();
  const [filter, setFilter] = useState<Filter>('open');
  const [editing, setEditing] = useState<Partial<Thread> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const threads = project.threads || [];
  const openCount = threads.filter((t) => t.status === 'planted' || t.status === 'reinforced').length;
  const resolvedCount = threads.filter((t) => t.status === 'resolved').length;

  const visible = threads.filter((t) => {
    if (filter === 'all') return true;
    if (filter === 'resolved') return t.status === 'resolved' || t.status === 'abandoned';
    return t.status === 'planted' || t.status === 'reinforced';
  });

  const save = async () => {
    if (!editing?.name?.trim()) { setErr('线索名不能为空'); return; }
    try {
      if (editing.id) await api.put(`/projects/${project.id}/threads/${editing.id}`, editing);
      else await api.post(`/projects/${project.id}/threads`, editing);
      setEditing(null);
      setErr(null);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const setStatus = async (t: Thread, status: Thread['status']) => {
    try {
      await api.put(`/projects/${project.id}/threads/${t.id}`, { status });
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const extract = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await api.post(`/projects/${project.id}/threads/extract`, {});
      await reload();
      setNote(r.added > 0
        ? `已从第 ${cnNum(r.chapterIdx)} 章正文补录 ${r.added} 条线索。`
        : `第 ${cnNum(r.chapterIdx)} 章没有发现新的伏笔线索（已自动跳过重复项）。`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <span className="muted small">每章写完后，AI 会自动回流伏笔状态：新埋、推进、回收。下一次生成会带着它们，避免写着写着就忘了。</span>
        <span className="grow" />
        <button className="btn" disabled={busy} onClick={extract}>{busy ? <><Spinner /> 分析中…</> : '从正文补录'}</button>
        <button className="btn primary" onClick={() => { setEditing({ kind: '伏笔', status: 'planted' }); setErr(null); }}>＋ 新增线索</button>
      </div>

      {note && <div className="hint-box" style={{ marginBottom: 14 }}>{note}</div>}
      <ErrorNote error={err} />

      <div className="stat-row" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-num">{openCount}<em>条</em></div>
          <div className="stat-label">进行中 · 会注入后续正文</div>
        </div>
        <div className="stat">
          <div className="stat-num">{resolvedCount}<em>条</em></div>
          <div className="stat-label">已回收</div>
        </div>
        <div className="stat">
          <div className="stat-num">{threads.length}<em>条</em></div>
          <div className="stat-label">线索总数</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <div className="seg">
          {(['open', 'resolved', 'all'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'open' ? '进行中' : f === 'resolved' ? '已回收' : '全部'}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="muted small">共 {visible.length} 条</span>
      </div>

      {visible.length === 0 ? (
        <Empty
          title={filter === 'open' ? '还没有进行中的伏笔' : '这里还没有线索'}
          desc="写完正文后点『从正文补录』，或手动记下一条你想在后续回收的伏笔。它们会随上下文一起交给 AI。"
          action={<Link className="btn" to={`/p/${project.id}/write`}>去写作台</Link>}
        />
      ) : (
        <div className="card" style={{ padding: '4px 20px' }}>
          {visible.map((t) => (
            <div key={t.id} className="thread-row">
              <div className="thread-main">
                <div className="row-wrap" style={{ gap: 8 }}>
                  <b className="thread-name">{t.name}</b>
                  <Badge tone={THREAD_STATUS_TONE[t.status]}>{THREAD_STATUS_NAMES[t.status] || t.status}</Badge>
                  <span className="chip">{t.kind}</span>
                  {t.planted_chapter ? <span className="muted small">首埋 第{cnNum(t.planted_chapter)}章</span> : null}
                  {t.last_chapter && t.last_chapter !== t.planted_chapter ? <span className="muted small">最近 第{cnNum(t.last_chapter)}章</span> : null}
                </div>
                {t.detail ? <div className="thread-detail">{t.detail}</div> : null}
              </div>
              <div className="row" style={{ gap: 2 }}>
                {t.status !== 'resolved' && t.status !== 'abandoned' ? (
                  <>
                    <button className="btn ghost small" onClick={() => setStatus(t, 'reinforced')}>推进</button>
                    <button className="btn ghost small" onClick={() => setStatus(t, 'resolved')}>回收</button>
                  </>
                ) : (
                  <button className="btn ghost small" onClick={() => setStatus(t, 'planted')}>重新启用</button>
                )}
                <button className="btn ghost small" onClick={() => { setEditing(t); setErr(null); }}>编辑</button>
                <ConfirmButton
                  className="btn ghost small"
                  onConfirm={async () => {
                    try {
                      await api.del(`/projects/${project.id}/threads/${t.id}`);
                      await reload();
                    } catch (e: any) {
                      setErr(e.message);
                    }
                  }}
                >
                  删除
                </ConfirmButton>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? '编辑伏笔线索' : '新增伏笔线索'} onClose={() => setEditing(null)}>
          <Field label="名称" hint="后续写后整理会沿用同名线索">
            <input type="text" value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例：罗盘背面被刮掉的名字" />
          </Field>
          <div className="grid grid-2">
            <Field label="类型">
              <select value={editing.kind || '伏笔'} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Thread['kind'] })}>
                {THREAD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
            <Field label="状态">
              <select value={editing.status || 'planted'} onChange={(e) => setEditing({ ...editing, status: e.target.value as Thread['status'] })}>
                {Object.entries(THREAD_STATUS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
          </div>
          <Field label="说明" hint="埋在哪里、指向什么、打算怎么回收">
            <textarea rows={3} value={editing.detail || ''} onChange={(e) => setEditing({ ...editing, detail: e.target.value })} />
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
