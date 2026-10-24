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
  const [notice, setNotice] = useState<string | null>(null);
  const [outlineAsk, setOutlineAsk] = useState(false);
  const [editing, setEditing] = useState<ChapterDraft | null>(null);
  const [volEditing, setVolEditing] = useState<{ id?: number; idx?: number; title: string; summary: string; chapterCount: number } | null>(null);
  const [volErr, setVolErr] = useState<string | null>(null);
  const [volSaving, setVolSaving] = useState(false);
  const [volNote, setVolNote] = useState<{ id: number; kind: 'busy' | 'error'; text: string } | null>(null);
  const [statusBusy, setStatusBusy] = useState<number | null>(null);

  const STATUS_LABEL: Record<string, string> = { planned: '待写', draft: '草稿', done: '完成' };

  const setChapterStatus = async (c: { id: number; title: string; status: string }, status: string) => {
    if (status === c.status) return;
    setStatusBusy(c.id); setErr(null); setNotice(null);
    try {
      await api.put(`/projects/${project.id}/chapters/${c.id}`, { status });
      await reload();
      setNotice(`已将「${c.title || '未命名章节'}」标记为${STATUS_LABEL[status]}。`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setStatusBusy(null);
    }
  };

  const writtenChapters = project.chapters.filter((c) => c.word_count > 0);
  const hasContent = writtenChapters.length > 0;
  const writtenWords = writtenChapters.reduce((n, c) => n + c.word_count, 0);

  /** 已有正文时先让用户选择处理方式，避免直接覆盖丢失内容 */
  const genOutline = () => {
    if (hasContent) { setErr(null); setNotice(null); setOutlineAsk(true); return; }
    void runOutline('overwrite');
  };

  const runOutline = async (mode: 'overwrite' | 'skip') => {
    setOutlineAsk(false);
    setBusy('outline'); setErr(null); setNotice(null);
    try {
      const r = await api.post(`/projects/${project.id}/outline`, { mode });
      await reload();
      if (mode === 'skip') {
        setNotice(r.addedVolumes > 0
          ? `已保留 ${r.preservedChapters} 个章节；新增 ${r.addedVolumes} 个卷，点各卷的「AI 拆章」即可补齐章节。`
          : `已保留 ${r.preservedChapters} 个章节；现有卷数已覆盖本次规划，未新增卷，已有内容未改动。`);
      } else if (r.deletedChapters) {
        setNotice(`已删除 ${r.deletedChapters} 个旧章节，并按新规划重建卷纲。`);
      }
    } catch (e: any) {
      setErr(e.message);
      /* 服务端仍有正文时返回 409：重新弹出选择框，避免用户卡在报错上 */
      if (e.status === 409) setOutlineAsk(true);
    } finally {
      setBusy(null);
    }
  };

  const planVolume = async (vid: number) => {
    const vol = volumes.find((v) => v.id === vid);
    setBusy('vol' + vid); setErr(null); setNotice(null);
    /* 拆章耗时较长，在卷内给出即时反馈，避免用户以为点击没反应 */
    setVolNote({ id: vid, kind: 'busy', text: 'AI 正在拆章，通常需要 20–60 秒，请稍候…' });
    try {
      const r = await api.post(`/projects/${project.id}/volumes/${vid}/plan`);
      await reload();
      setVolNote(null);
      setNotice(`「${vol?.title || '该卷'}」拆章完成：生成 ${r.planned ?? 0} 章${r.writtenChapters ? `，保留 ${r.writtenChapters} 章正文` : ''}。`);
    } catch (e: any) {
      setErr(e.message);
      setVolNote({ id: vid, kind: 'error', text: e.message });
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

  const openVolumeEditor = (v?: (typeof volumes)[number]) => {
    setEditing(null);
    setVolErr(null);
    setVolEditing(v
      ? {
        id: v.id, idx: v.idx, title: v.title, summary: v.summary || '',
        chapterCount: project.chapters.filter((c) => c.volume_id === v.id).length,
      }
      : { title: '', summary: '', chapterCount: 0 });
  };

  const saveVolume = async () => {
    if (!volEditing) return;
    const isEdit = !!volEditing.id;
    const title = volEditing.title.trim();
    const summary = volEditing.summary.trim();
    if (!title) { setVolErr('卷名不能为空'); return; }
    if (title.length > 80) { setVolErr('卷名不能超过 80 个字'); return; }
    if (summary.length > 2000) { setVolErr('卷简介不能超过 2000 个字'); return; }
    if (volumes.some((v) => v.id !== volEditing.id && v.title.trim() === title)) {
      setVolErr('已存在同名卷，请换一个卷名'); return;
    }
    setVolSaving(true); setVolErr(null);
    try {
      if (isEdit) {
        await api.put(`/projects/${project.id}/volumes/${volEditing.id}`, { title, summary });
      } else {
        await api.post(`/projects/${project.id}/volumes`, { title, summary });
      }
      setVolEditing(null);
      await reload();
      setNotice(isEdit ? `已保存卷「${title}」的修改。` : `已新增卷「${title}」。`);
    } catch (e: any) {
      setVolErr(e.message);
    } finally {
      setVolSaving(false);
    }
  };

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <span className="muted small">卷纲是书的骨架，章节任务单是每一章的施工图 —— 都是 AI 起草、你说了算。</span>
        <span className="grow" />
        <button className="btn" onClick={() => openVolumeEditor()}>＋ 新增卷</button>
        <button className="btn" onClick={() => setEditing({ volumeId: volumes[0]?.id ?? null, title: '新章节', brief: '', scenes: '', cast: '', hook: '' })}>＋ 手动加章</button>
        <button className="btn primary" disabled={busy === 'outline'} onClick={genOutline}>
          {busy === 'outline' ? <><Spinner /> 规划中…</> : volumes.length ? '重新生成卷纲' : 'AI 生成卷纲'}
        </button>
      </div>
      <ErrorNote error={err} />
      {notice && <div className="notice-note">✓ {notice}</div>}

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
              <div className="row-wrap" style={{ marginBottom: 8 }}>
                <span style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 600 }}>{v.title}</span>
                <Badge>{chapters.length} 章</Badge>
                <span className="grow" />
                <button className="btn ghost small" onClick={() => openVolumeEditor(v)}>编辑卷</button>
                <button
                  className="btn small"
                  disabled={!!busy}
                  title={busy && busy !== 'vol' + v.id
                    ? '正在拆分其他卷，请稍候'
                    : chapters.length ? '重新生成本卷章节任务单，已有的正文章节会保留' : undefined}
                  onClick={() => planVolume(v.id)}
                >
                  {busy === 'vol' + v.id ? <><Spinner /> 拆章中…</> : chapters.length ? '重新拆章' : 'AI 拆章'}
                </button>
              </div>
              <p className="muted" style={{ lineHeight: 1.8, fontSize: 13, marginBottom: 10 }}>{v.summary}</p>
              {volNote?.id === v.id && (
                <p
                  className={volNote.kind === 'error' ? 'small' : 'muted small'}
                  style={{ margin: '0 0 8px', color: volNote.kind === 'error' ? 'var(--bad)' : undefined }}
                >
                  {volNote.kind === 'error' ? `拆章失败：${volNote.text}` : volNote.text}
                </p>
              )}
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
                        <td><span className="row" style={{ gap: 6 }}><span className={`dot ${c.status}`} /><select
                          className="status-select"
                          value={c.status}
                          disabled={statusBusy === c.id}
                          onChange={(e) => setChapterStatus(c, e.target.value)}
                        >
                          <option value="planned">待写</option>
                          <option value="draft">草稿</option>
                          <option value="done">完成</option>
                        </select></span></td>
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
            <thead><tr><th style={{ width: 56 }}>章</th><th>章节名</th><th>本章任务</th><th style={{ width: 90 }}>状态</th><th style={{ width: 130 }}>操作</th></tr></thead>
            <tbody>
              {orphanChapters.map((c) => (
                <tr key={c.id}>
                  <td className="muted">第{cnNum(c.idx)}章</td>
                  <td><b>{c.title || '（未命名）'}</b></td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{c.brief}</td>
                  <td><span className="row" style={{ gap: 6 }}><span className={`dot ${c.status}`} /><select
                    className="status-select"
                    value={c.status}
                    disabled={statusBusy === c.id}
                    onChange={(e) => setChapterStatus(c, e.target.value)}
                  >
                    <option value="planned">待写</option>
                    <option value="draft">草稿</option>
                    <option value="done">完成</option>
                  </select></span></td>
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
        </div>
      )}

      {outlineAsk && (
        <Modal title="重建卷纲 · 已有正文章节" onClose={() => setOutlineAsk(false)} wide>
          <p className="muted" style={{ lineHeight: 1.8, fontSize: 13 }}>
            当前作品已有 <b>{writtenChapters.length}</b> 章正文（约 {writtenWords} 字），共 {project.chapters.length} 个章节、{volumes.length} 卷。
            重建卷纲会影响章节规划，请选择处理方式：
          </p>
          <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 600 }}>确认覆盖</div>
              <p className="muted small" style={{ lineHeight: 1.7, marginTop: 4 }}>
                删除全部 {project.chapters.length} 个章节（其中 {writtenChapters.length} 章正文共 {writtenWords} 字，删除后不可恢复）并清空卷纲，
                再按 AI 新规划完整生成卷纲。
              </p>
              <button className="btn danger small" disabled={busy === 'outline'} onClick={() => runOutline('overwrite')}>
                删除全部章节并重建
              </button>
            </div>
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 600 }}>跳过已有章节</div>
              <p className="muted small" style={{ lineHeight: 1.7, marginTop: 4 }}>
                保留现有 {project.chapters.length} 个章节与 {volumes.length} 卷的全部内容、顺序、分卷和任务单，不做任何删改；
                仅在 AI 新规划的卷数多于现有卷数时，把多出来的卷追加到末尾。新增卷不会自动生成章节，需再点「AI 拆章」补齐。
              </p>
              <button className="btn primary small" disabled={busy === 'outline'} onClick={() => runOutline('skip')}>
                保留已有章节，仅补齐缺失卷
              </button>
            </div>
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 600 }}>取消操作</div>
              <p className="muted small" style={{ lineHeight: 1.7, marginTop: 4 }}>
                不删除、不修改任何内容，返回架构规划页。
              </p>
              <button className="btn ghost small" onClick={() => setOutlineAsk(false)}>取消</button>
            </div>
          </div>
        </Modal>
      )}

      {volEditing && (
        <Modal title={volEditing.id ? `编辑卷 · 第${cnNum(volEditing.idx || 0)}卷` : '新增卷'} onClose={() => setVolEditing(null)}>
          <Field label="卷名" hint="必填，最多 80 字">
            <input type="text" value={volEditing.title} autoFocus onChange={(e) => setVolEditing({ ...volEditing, title: e.target.value })} />
          </Field>
          <Field label="卷简介" hint="本卷阶段目标、主要冲突与结尾钩子，最多 2000 字">
            <textarea rows={4} value={volEditing.summary} onChange={(e) => setVolEditing({ ...volEditing, summary: e.target.value })} />
          </Field>
          {volEditing.id && (
            <div className="grid grid-2">
              <Field label="卷序号（只读）"><input type="text" value={`第${cnNum(volEditing.idx || 0)}卷`} readOnly /></Field>
              <Field label="关联章节（只读）"><input type="text" value={`${volEditing.chapterCount} 章`} readOnly /></Field>
            </div>
          )}
          {volErr && <ErrorNote error={volErr} />}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setVolEditing(null)}>取消</button>
            <button className="btn primary" disabled={volSaving} onClick={saveVolume}>
              {volSaving ? <><Spinner /> 保存中…</> : '保存'}
            </button>
          </div>
        </Modal>
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
