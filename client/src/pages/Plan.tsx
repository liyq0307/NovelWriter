import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, cnNum } from '../api';
import { useProject } from './ProjectPage';
import { Modal, Field, Spinner, ErrorNote, Empty, ConfirmButton, Badge } from '../components/ui';
import type { Chapter } from '../types';

/** 章节编辑草稿：cast 用顿号分隔的字符串，volumeId 为下拉框值 */
interface ChapterDraft {
  id?: number;
  idx?: number;
  volumeId?: number | null;
  title: string;
  brief: string;
  scenes: string;
  cast: string;
  hook: string;
}

export default function Plan() {
  const { project, reload } = useProject();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChapterDraft | null>(null);

  const hasContent = project.chapters.some((c) => c.word_count > 0);

  const genOutline = async () => {
    if (hasContent && !window.confirm('已有正文章节：重建卷纲会删除全部章节规划（含未写章节的任务单），确定继续？')) return;
    setBusy('outline'); setErr(null);
    try {
      await api.post(`/projects/${project.id}/outline`);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const planVolume = async (vid: number) => {
    setBusy('vol' + vid); setErr(null);
    try {
      await api.post(`/projects/${project.id}/volumes/${vid}/plan`);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const saveChapter = async () => {
    if (!editing) return;
    const cast = editing.cast.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
    try {
      if (editing.id) {
        await api.put(`/projects/${project.id}/chapters/${editing.id}`, {
          title: editing.title, brief: editing.brief, scenes: editing.scenes, hook: editing.hook, cast, volumeId: editing.volumeId,
        });
      } else {
        await api.post(`/projects/${project.id}/chapters`, {
          volumeId: editing.volumeId, title: editing.title || '新章节', brief: editing.brief, scenes: editing.scenes, cast, hook: editing.hook,
        });
      }
      setEditing(null);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const volumes = project.volumes;
  const orphanChapters = project.chapters.filter((c) => !c.volume_id || !volumes.some((v) => v.id === c.volume_id));

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <span className="muted small">卷纲是书的骨架，章节任务单是每一章的施工图 —— 都是 AI 起草、你说了算。</span>
        <span className="grow" />
        <button className="btn" onClick={() => setEditing({ volumeId: volumes[0]?.id ?? null, title: '新章节', brief: '', scenes: '', cast: '', hook: '' })}>＋ 手动加章</button>
        <button className="btn primary" disabled={busy === 'outline'} onClick={genOutline}>
          {busy === 'outline' ? <><Spinner /> 规划中…</> : volumes.length ? '重新生成卷纲' : 'AI 生成卷纲'}
        </button>
      </div>
      <ErrorNote error={err} />

      {volumes.length === 0 ? (
        <Empty
          title="还没有卷纲"
          desc={project.type === 'short' ? '短篇将由 AI 规划 3-6 个部分完成起承转合。' : 'AI 会规划前 3-4 卷：每卷的阶段目标、主要冲突与结尾钩子，然后逐卷拆成章节任务单。'}
          action={<button className="btn primary" disabled={busy === 'outline'} onClick={genOutline}>{busy === 'outline' ? <Spinner /> : 'AI 生成卷纲'}</button>}
        />
      ) : (
        volumes.map((v) => {
          const chapters = project.chapters.filter((c) => c.volume_id === v.id);
          return (
            <div key={v.id} className="card" style={{ marginBottom: 16 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <span style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 600 }}>{v.title}</span>
                <Badge>{chapters.length} 章</Badge>
                <span className="grow" />
                <button className="btn small" disabled={!!busy} onClick={() => planVolume(v.id)}>
                  {busy === 'vol' + v.id ? <><Spinner /> 拆章中…</> : chapters.length ? '继续拆章' : 'AI 拆章'}
                </button>
              </div>
              <p className="muted" style={{ lineHeight: 1.8, fontSize: 13, marginBottom: 10 }}>{v.summary}</p>
              {chapters.length > 0 && (
                <table className="table">
                  <thead>
                    <tr><th style={{ width: 56 }}>章</th><th style={{ width: 130 }}>章节名</th><th>本章任务</th><th style={{ width: 90 }}>状态</th><th style={{ width: 130 }}>操作</th></tr>
                  </thead>
                  <tbody>
                    {chapters.map((c) => (
                      <tr key={c.id}>
                        <td className="muted">第{cnNum(c.idx)}章</td>
                        <td><b>{c.title || '（未命名）'}</b></td>
                        <td className="muted" style={{ fontSize: 12.5 }}>{c.brief}</td>
                        <td><span className="row" style={{ gap: 6 }}><span className={`dot ${c.status}`} />{c.status === 'planned' ? '待写' : c.status === 'draft' ? '草稿' : '完成'}</span></td>
                        <td>
                          <span className="row" style={{ gap: 2 }}>
                            <Link className="btn ghost small" to={`/p/${project.id}/write/${c.id}`}>写作</Link>
                            <button className="btn ghost small" onClick={() => setEditing({ id: c.id, idx: c.idx, title: c.title, brief: c.brief, scenes: c.scenes, cast: (c.cast || []).join('、'), hook: c.hook, volumeId: c.volume_id })}>编辑</button>
                            <ConfirmButton
                              className="btn ghost small"
                              onConfirm={async () => { await api.del(`/projects/${project.id}/chapters/${c.id}`); await reload(); }}
                            >
                              删除
                            </ConfirmButton>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })
      )}

      {orphanChapters.length > 0 && (
        <div className="card">
          <div className="card-title">未分卷章节</div>
          <table className="table">
            <thead><tr><th style={{ width: 56 }}>章</th><th>章节名</th><th>本章任务</th><th style={{ width: 130 }}>操作</th></tr></thead>
            <tbody>
              {orphanChapters.map((c) => (
                <tr key={c.id}>
                  <td className="muted">第{cnNum(c.idx)}章</td>
                  <td><b>{c.title}</b></td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{c.brief}</td>
                  <td><Link className="btn ghost small" to={`/p/${project.id}/write/${c.id}`}>写作</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? `编辑章节 · 第${cnNum(editing.idx || 0)}章` : '新增章节'} onClose={() => setEditing(null)} wide>
          <div className="grid grid-2">
            <Field label="章节名"><input type="text" value={editing.title || ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
            <Field label="所属卷">
              <select value={editing.volumeId ?? ''} onChange={(e) => setEditing({ ...editing, volumeId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">（未分卷）</option>
                {volumes.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
              </select>
            </Field>
          </div>
          <Field label="本章任务" hint="发生什么、推进什么、揭示什么"><textarea rows={2} value={editing.brief || ''} onChange={(e) => setEditing({ ...editing, brief: e.target.value })} /></Field>
          <Field label="场景" hint="地点 + 事件要点"><input type="text" value={editing.scenes || ''} onChange={(e) => setEditing({ ...editing, scenes: e.target.value })} /></Field>
          <Field label="出场人物" hint="用顿号分隔，需与角色库名字一致"><input type="text" value={editing.cast} onChange={(e) => setEditing({ ...editing, cast: e.target.value })} /></Field>
          <Field label="章末钩子"><input type="text" value={editing.hook || ''} onChange={(e) => setEditing({ ...editing, hook: e.target.value })} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary" onClick={saveChapter}>保存</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
