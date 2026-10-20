import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, sse, countWords, cnNum, fmtTime, REVISION_REASON_NAMES, THREAD_STATUS_NAMES } from '../api';
import { useProject } from './ProjectPage';
import { Modal, Field, Spinner, ErrorNote, Empty, ConfirmButton, Badge } from '../components/ui';
import type { Batch, Chapter, Review, Revision } from '../types';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved';

interface PreviewState {
  mode: 'write' | 'continue' | 'rewrite';
  text: string;
  streaming: boolean;
  /** 采纳时把文本插入/替换到哪里 */
  at?: number;
  selStart?: number;
  selEnd?: number;
}

export default function Writer() {
  const { id, chapterId } = useParams();
  const pid = Number(id);
  const { project, reload } = useProject();
  const nav = useNavigate();

  const [ch, setCh] = useState<Chapter | null>(null);
  const [content, setContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [streaming, setStreaming] = useState<null | 'write' | 'continue' | 'rewrite'>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [follow, setFollow] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyReview, setBusyReview] = useState(false);
  const [busySync, setBusySync] = useState(false);
  const [rewriteModal, setRewriteModal] = useState<null | { selection: string; before: string; after: string; instruction: string }>(null);

  /* 版本历史 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [revPreview, setRevPreview] = useState<{ rev: Revision; content: string } | null>(null);
  const [busyRev, setBusyRev] = useState(false);

  /* 批量连写 */
  const [batchOpen, setBatchOpen] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [batchText, setBatchText] = useState('');
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [batchLog, setBatchLog] = useState<{ idx: number; title: string; wordCount: number; reviewScore: number | null; flavorScore?: number | null; revised?: boolean; synced: number; skipped?: boolean }[]>([]);
  const [batchForm, setBatchForm] = useState({ from: 1, to: 1, review: true, sync: true, overwrite: false });

  const taRef = useRef<HTMLTextAreaElement>(null);
  const posRef = useRef({ start: 0, end: 0 });
  /* 章节加载序号：快速切章时丢弃过期响应，避免旧章节内容覆盖新章节 */
  const loadSeq = useRef(0);
  /* 当前编辑器快照：离开 / 切章时用来兜底保存还没被防抖落库的正文 */
  const liveRef = useRef({ id: 0, content: '', saved: '', hold: false });
  liveRef.current = {
    id: ch?.id ?? 0, content, saved: ch?.content ?? '',
    /* 生成 / 连写期间编辑器里的内容由流式结果或后台任务接管，不做兜底保存 */
    hold: !!streaming || !!batch?.running,
  };

  /* 选中章节：URL 参数或自动选第一章 */
  useEffect(() => {
    if (project.chapters.length === 0) return;
    const target = chapterId ? Number(chapterId) : project.chapters[0].id;
    if (!chapterId) nav(`/p/${pid}/write/${target}`, { replace: true });
  }, [project.chapters, chapterId, pid, nav]);

  const loadChapter = useCallback(async () => {
    if (!chapterId) return;
    const seq = ++loadSeq.current;
    const c: Chapter = await api.get(`/projects/${pid}/chapters/${chapterId}`);
    if (seq !== loadSeq.current) return; // 期间已切到别的章节
    setCh(c);
    setContent(c.content || '');
    setSaveState('idle');
  }, [pid, chapterId]);

  useEffect(() => {
    let alive = true;
    loadChapter().then(() => { if (alive) { setPreview(null); setNote(null); setErr(null); } }).catch((e) => { if (alive) setErr(e.message); });
    return () => {
      alive = false;
      /* 切章或离开写作台时，把还留在防抖窗口里的正文补存一次，避免丢字 */
      const live = liveRef.current;
      if (live.id && !live.hold && live.content !== live.saved) {
        api.put(`/projects/${pid}/chapters/${live.id}/content`, { content: live.content }).catch(() => { /* 兜底保存失败不打断导航 */ });
      }
    };
  }, [loadChapter, pid]);

  /* 进入写作台时检查是否有正在进行的连写任务 */
  useEffect(() => {
    let alive = true;
    api.get(`/projects/${pid}/batches`).then((list: Batch[]) => {
      if (!alive || !Array.isArray(list)) return;
      const active = list.find((b) => b.status === 'running' || b.status === 'paused');
      if (active) {
        setBatch(active);
        if (active.status === 'running') attachBatch(active.id);
      }
    }).catch(() => { /* 无任务不影响写作 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  /* 自动保存（防抖 900ms） */
  const doSave = useCallback(async (text: string, sync = false, reason = 'autosave') => {
    const q = new URLSearchParams();
    if (sync) q.set('sync', '1');
    if (reason !== 'autosave') q.set('reason', reason);
    const r = await api.put(`/projects/${pid}/chapters/${chapterId}/content?${q.toString()}`, { content: text });
    if (sync) {
      if (r.syncError) {
        setNote(`正文已保存，但写后整理失败：${r.syncError}`);
      } else {
        const parts = [];
        if (r.synced?.length) parts.push(`角色 ${r.synced.map((s: any) => s.name).join('、')}`);
        if (r.threads) parts.push(`${r.threads} 条线索更新`);
        if (parts.length) setNote(`写后整理完成：${parts.join('；')}`);
        else if (r.summary) setNote('写后整理完成：已更新本章摘要。');
      }
      await reload();
    }
    if (r.summary) setCh((c) => (c ? { ...c, summary: r.summary } : c));
    return r;
  }, [pid, chapterId, reload]);

  useEffect(() => {
    if (!ch) return;
    if (streaming) return;
    if (batch?.running) return;
    if (content === (ch.content || '')) return;
    setSaveState('dirty');
    const t = window.setTimeout(async () => {
      setSaveState('saving');
      try {
        await doSave(content);
        setCh((c) => (c ? { ...c, content, word_count: countWords(content) } : c));
        setSaveState('saved');
      } catch (e: any) {
        setSaveState('dirty');
        setErr(`保存失败：${e.message}`);
      }
    }, 900);
    return () => window.clearTimeout(t);
  }, [content, ch, streaming, doSave]);

  const cursor = () => {
    const ta = taRef.current;
    if (!ta) return content.length;
    return posRef.current.start ?? ta.selectionStart ?? content.length;
  };
  const selection = () => {
    const ta = taRef.current;
    if (!ta) return { start: 0, end: 0, text: '' };
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    return { start, end, text: content.slice(start, end) };
  };

  /* ---------- 整章生成 ---------- */
  const genChapter = async () => {
    if (!ch) return;
    if ((ch.content || '').trim() && !window.confirm('本章已有正文，重新生成将替换编辑器内容（当前内容不会自动保留）。继续？')) return;
    setErr(null); setNote(null);
    setStreaming('write');
    let acc = '';
    await sse(`/projects/${pid}/chapters/${ch.id}/write`, {}, {
      onDelta: (d) => {
        acc += d.text;
        if (follow) setContent(acc);
        setPreview((p) => (p || { mode: 'write', text: '', streaming: true }));
        setPreview((p) => (p ? { ...p, text: acc, streaming: true } : p));
      },
      onDone: async (d) => {
        setStreaming(null);
        const finalText: string = d.text || acc;
        if (follow) {
          setContent(finalText);
          setPreview(null);
          try {
            setSaveState('saving');
            await doSave(finalText, true, 'generate');
            setCh((c) => (c ? { ...c, content: finalText, word_count: countWords(finalText) } : c));
            setSaveState('saved');
          } catch (e: any) {
            setSaveState('dirty');
            setErr(`生成完成但保存失败：${e.message}`);
          }
        } else {
          setPreview({ mode: 'write', text: finalText, streaming: false });
        }
      },
      onError: (e) => {
        setStreaming(null);
        if (!follow && acc) setPreview({ mode: 'write', text: acc, streaming: false });
        else setPreview(null);
        setErr(e.message);
      },
    });
  };

  /* ---------- 光标续写 ---------- */
  const genContinue = async () => {
    if (!ch) return;
    const at = cursor();
    setErr(null); setNote(null);
    setStreaming('continue');
    let acc = '';
    const apply = (text: string) => {
      setContent((c) => c.slice(0, at) + text + c.slice(at));
    };
    await sse(`/projects/${pid}/chapters/${ch.id}/continue`, { content, cursor: at, target: 800 }, {
      onDelta: (d) => {
        acc += d.text;
        if (follow) apply(acc);
        setPreview((p) => (p ? { ...p, mode: 'continue', text: acc, streaming: true } : { mode: 'continue', text: acc, streaming: true, at }));
      },
      onDone: async (d) => {
        setStreaming(null);
        const finalText: string = d.text || acc;
        if (follow) {
          apply(finalText);
          setPreview(null);
        } else {
          setPreview({ mode: 'continue', text: finalText, streaming: false, at });
        }
      },
      onError: (e) => {
        setStreaming(null);
        setErr(e.message);
      },
    });
  };

  /* ---------- 局部改写 ---------- */
  const openRewrite = () => {
    const sel = selection();
    if (!sel.text.trim()) { setErr('请先用鼠标选中要改写的片段'); return; }
    setRewriteModal({ selection: sel.text, before: content.slice(Math.max(0, sel.start - 200), sel.start), after: content.slice(sel.end, sel.end + 200), instruction: '' });
    posRef.current = { start: sel.start, end: sel.end };
  };
  const genRewrite = async () => {
    if (!ch || !rewriteModal) return;
    if (!rewriteModal.instruction.trim()) { setErr('请填写改写要求'); return; }
    setErr(null);
    setRewriteModal(null);
    setStreaming('rewrite');
    let acc = '';
    await sse(`/projects/${pid}/chapters/${ch.id}/rewrite`, {
      selection: rewriteModal.selection,
      instruction: rewriteModal.instruction,
      before: rewriteModal.before,
      after: rewriteModal.after,
    }, {
      onDelta: (d) => {
        acc += d.text;
        setPreview({ mode: 'rewrite', text: acc, streaming: true, selStart: posRef.current.start, selEnd: posRef.current.end });
      },
      onDone: (d) => {
        setStreaming(null);
        setPreview({ mode: 'rewrite', text: d.text || acc, streaming: false, selStart: posRef.current.start, selEnd: posRef.current.end });
      },
      onError: (e) => {
        setStreaming(null);
        setErr(e.message);
      },
    });
  };

  const acceptPreview = async () => {
    if (!preview || !ch) return;
    let next = content;
    if (preview.mode === 'write') {
      next = preview.text;
    } else if (preview.mode === 'continue') {
      const at = preview.at ?? content.length;
      next = content.slice(0, at) + preview.text + content.slice(at);
    } else if (preview.mode === 'rewrite') {
      const s = preview.selStart ?? 0;
      const e = preview.selEnd ?? 0;
      next = content.slice(0, s) + preview.text + content.slice(e);
    }
    setPreview(null);
    setContent(next);
    setSaveState('saving');
    try {
      await doSave(next, preview.mode === 'write', preview.mode === 'write' ? 'generate' : 'manual');
      setCh((c) => (c ? { ...c, content: next, word_count: countWords(next) } : c));
      setSaveState('saved');
    } catch (e: any) {
      setSaveState('dirty');
      setErr(`保存失败：${e.message}`);
    }
  };

  /* ---------- 检查与同步 ---------- */
  const runReview = async () => {
    if (!ch) return;
    setBusyReview(true); setErr(null);
    try {
      const r = await api.post(`/projects/${pid}/chapters/${ch.id}/review`);
      const rv: Review = r.review;
      setCh((c) => (c ? { ...c, review: rv } : c));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyReview(false);
    }
  };

  const runSync = async () => {
    if (!ch) return;
    setBusySync(true); setErr(null);
    try {
      const r = await api.post(`/projects/${pid}/chapters/${ch.id}/sync-state`);
      const parts = [];
      if (r.updated?.length) parts.push(`角色 ${r.updated.map((s: any) => s.name).join('、')}`);
      if (r.threads) parts.push(`${r.threads} 条线索更新`);
      setNote(parts.length ? `写后整理完成：${parts.join('；')}。` : 'AI 判断本章没有需要同步的资料变化。');
      if (r.summary) setCh((c) => (c ? { ...c, summary: r.summary } : c));
      await reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusySync(false);
    }
  };

  const saveTitle = async () => {
    if (!ch) return;
    await api.put(`/projects/${pid}/chapters/${ch.id}`, { title: ch.title });
    reload();
  };

  /* ---------- 版本历史 ---------- */
  const openHistory = async () => {
    setHistoryOpen(true); setRevisions(null); setRevPreview(null); setErr(null); setBusyRev(true);
    try {
      setRevisions(await api.get(`/projects/${pid}/chapters/${chapterId}/revisions`));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyRev(false);
    }
  };

  const previewRevision = async (rev: Revision) => {
    setBusyRev(true); setErr(null);
    try {
      const full = await api.get(`/projects/${pid}/chapters/${chapterId}/revisions/${rev.id}`);
      setRevPreview({ rev, content: full.content || '' });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyRev(false);
    }
  };

  const saveManualRevision = async () => {
    try {
      await api.post(`/projects/${pid}/chapters/${chapterId}/revisions`, { reason: 'manual' });
      await openHistory();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const restoreRevision = async () => {
    if (!revPreview) return;
    if (!window.confirm('回滚会用这个版本覆盖当前正文（当前正文会先留一个版本）。继续？')) return;
    setBusyRev(true); setErr(null);
    try {
      const r = await api.post(`/projects/${pid}/chapters/${chapterId}/revisions/${revPreview.rev.id}/restore`);
      setContent(r.chapter.content || '');
      setCh(r.chapter);
      setSaveState('saved');
      setHistoryOpen(false);
      setRevPreview(null);
      await reload();
      setNote(`已回滚到 ${fmtTime(revPreview.rev.created_at)} 的版本。`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyRev(false);
    }
  };

  /* ---------- 批量连写 ---------- */
  const openBatch = () => {
    const list = project.chapters;
    const first = list[0]?.idx ?? 1;
    const last = list[list.length - 1]?.idx ?? first;
    const current = ch?.idx ?? first;
    setBatchForm({ from: current, to: last, review: true, sync: true, overwrite: false });
    setBatchErr(null);
    setBatchOpen(true);
  };

  const startBatch = async () => {
    setBatchErr(null);
    try {
      const b = await api.post(`/projects/${pid}/batches`, batchForm);
      setBatch(b);
      setBatchLog([]);
      setBatchText('');
      setBatchOpen(false);
      attachBatch(b.id);
    } catch (e: any) {
      setBatchErr(e.message);
    }
  };

  async function attachBatch(bid: number) {
    await sse(`/projects/${pid}/batches/${bid}/attach`, {}, {
      onEvent: (ev, d) => {
        if (ev === 'batch' && d?.id) {
          setBatch(d);
        } else if (ev === 'delta') {
          setBatchText((t) => (t + (d.text || '')).slice(-6000));
        } else if (ev === 'chapter') {
          setBatchText('');
          setBatchLog((l) => [...l, d].slice(-60));
          if (String(d.chapterId) === String(chapterId)) loadChapter().catch(() => { /* 忽略 */ });
          reload();
        } else if (ev === 'skip') {
          setBatchLog((l) => [...l, { idx: d.idx, title: d.title, wordCount: 0, reviewScore: null, synced: 0, skipped: true }].slice(-60));
        } else if (ev === 'warning') {
          setBatchErr(d.message);
        } else if (ev === 'error') {
          setBatchErr(d.message);
        } else if (ev === 'done') {
          if (d?.batch) setBatch(d.batch);
          reload();
          loadChapter().catch(() => { /* 忽略 */ });
        }
      },
      onError: (d) => setBatchErr(d.message),
    });
  }

  const pauseBatch = async () => {
    if (!batch) return;
    try { setBatch(await api.post(`/projects/${pid}/batches/${batch.id}/pause`)); } catch (e: any) { setBatchErr(e.message); }
  };
  const resumeBatch = async () => {
    if (!batch) return;
    try {
      setBatchErr(null);
      const b = await api.post(`/projects/${pid}/batches/${batch.id}/resume`);
      setBatch(b);
      attachBatch(b.id);
    } catch (e: any) {
      setBatchErr(e.message);
    }
  };
  const cancelBatch = async () => {
    if (!batch) return;
    try { setBatch(await api.post(`/projects/${pid}/batches/${batch.id}/cancel`)); } catch (e: any) { setBatchErr(e.message); }
  };

  /* ---------- 渲染 ---------- */
  if (project.chapters.length === 0) {
    return (
      <Empty
        title="还没有章节"
        desc="先去「架构规划」生成卷纲并拆章，章节任务单会出现在这里。"
        action={<Link className="btn primary" to={`/p/${pid}/plan`}>去架构规划</Link>}
      />
    );
  }
  if (!ch) return <div className="loading-block"><Spinner text="正在加载章节…" /></div>;

  const vol = project.volumes.find((v) => v.id === ch.volume_id);
  const castChars = project.characters.filter((c) => ch.cast.includes(c.name));
  const review = ch.review;
  const openThreads = (project.threads || []).filter((t) => t.status === 'planted' || t.status === 'reinforced');
  const batchActive = batch?.status === 'running' || batch?.status === 'paused';
  const busyAll = !!streaming || !!batch?.running;

  return (
    <div className="writer">
      {/* 左：章节列表 */}
      <aside className="writer-side">
        <div className="aside-card" style={{ padding: '12px 8px' }}>
          <div className="ch-list">
            {project.volumes.map((v) => (
              <div key={v.id}>
                <div className="ch-vol">{v.title}</div>
                {project.chapters.filter((c) => c.volume_id === v.id).map((c) => (
                  <div key={c.id} className={`ch-item ${c.id === ch.id ? 'on' : ''}`} onClick={() => nav(`/p/${pid}/write/${c.id}`)}>
                    <span className={`dot ${c.status}`} />
                    <span>{cnNum(c.idx)}·{c.title || '未命名'}</span>
                    <span className="ch-words">{c.word_count || ''}</span>
                  </div>
                ))}
              </div>
            ))}
            {project.chapters.filter((c) => !c.volume_id || !project.volumes.some((v) => v.id === c.volume_id)).map((c) => (
              <div key={c.id} className={`ch-item ${c.id === ch.id ? 'on' : ''}`} onClick={() => nav(`/p/${pid}/write/${c.id}`)}>
                <span className={`dot ${c.status}`} />
                <span>{cnNum(c.idx)}·{c.title || '未命名'}</span>
                <span className="ch-words">{c.word_count || ''}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* 中：编辑器 */}
      <section>
        <div className="editor-card">
          <div className="editor-toolbar">
            <input
              className="editor-title-input"
              value={ch.title}
              onChange={(e) => setCh({ ...ch, title: e.target.value })}
              onBlur={saveTitle}
              placeholder="章节名"
            />
            <label className="row small muted" style={{ gap: 5, cursor: 'pointer' }} title="生成时实时写入编辑器；关闭则进入下方预览区，由你决定是否采纳">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} disabled={busyAll} />
              跟随写入
            </label>
            <button className="btn primary small" disabled={busyAll} onClick={genChapter}>
              {streaming === 'write' ? <><span className="pulse spin" />生成中…</> : ch.content ? '重新生成本章' : 'AI 生成本章'}
            </button>
            <button className="btn small" disabled={busyAll} onClick={genContinue}>光标续写</button>
            <button className="btn small" disabled={busyAll} onClick={openRewrite}>改写选中</button>
            <button className="btn small" disabled={busyAll} onClick={openBatch} title="在所选章节范围内连续生成，可暂停与恢复">批量连写</button>
            <button className="btn small" disabled={busyAll} onClick={openHistory} title="查看并回滚本章历史版本">历史版本</button>
            <span className="grow" />
            <button className="btn small" disabled={busyReview || busyAll} onClick={runReview}>{busyReview ? <Spinner /> : 'AI 检查本章'}</button>
            <button className="btn small" disabled={busySync || busyAll || !ch.content} onClick={runSync}>{busySync ? <Spinner /> : '写后整理'}</button>
          </div>
          <textarea
            ref={taRef}
            className="editor-area"
            value={content}
            readOnly={busyAll}
            onChange={(e) => setContent(e.target.value)}
            onSelect={(e) => {
              const ta = e.currentTarget;
              posRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
            }}
            placeholder="这里写正文。可以自己写，也可以让 AI 按本章任务生成，然后你来改 —— 人管控，AI 管写。"
          />
          <div className="editor-foot">
            <span>{countWords(content)} 字</span>
            {saveState === 'saving' && <span>保存中…</span>}
            {saveState === 'dirty' && <span>有未保存修改（自动保存中）</span>}
            {saveState === 'saved' && <span style={{ color: 'var(--ok)' }}>已保存</span>}
            <span className="grow" />
            {streaming && <span className="stream-indicator"><span className="pulse" />{streaming === 'write' ? 'AI 正在写本章' : streaming === 'continue' ? 'AI 正在续写' : 'AI 正在改写'}</span>}
          </div>

          {batch && (batchActive || batch.status === 'error' || batch.status === 'done') && (
            <div className="batch-panel">
              <div className="batch-head">
                <span className="batch-title">
                  {batch.status === 'running' ? '批量连写中' : batch.status === 'paused' ? '批量连写已暂停' : batch.status === 'error' ? '批量连写已停止' : '批量连写已完成'}
                </span>
                <Badge tone={batch.status === 'error' ? 'accent' : batch.status === 'done' ? 'ok' : 'info'}>
                  {batch.done_chapters} 章 · {batch.words_added} 字
                </Badge>
                <span className="muted small">范围 第{batch.from_idx}—{batch.to_idx} 章 · 进度至 第{batch.cursor_idx}章</span>
                <span className="grow" />
                {batch.status === 'running' && <button className="btn small" onClick={pauseBatch}>暂停</button>}
                {batch.status === 'paused' && <button className="btn primary small" onClick={resumeBatch}>继续</button>}
                {(batch.status === 'running' || batch.status === 'paused') && (
                  <ConfirmButton className="btn ghost small" onConfirm={cancelBatch}>取消</ConfirmButton>
                )}
                {!batchActive && (
                  <button className="btn ghost small" onClick={() => { setBatch(null); setBatchText(''); setBatchLog([]); setBatchErr(null); }}>收起</button>
                )}
              </div>
              {batch.message ? <div className="muted small">{batch.message}</div> : null}
              {batch.current && batch.status === 'running' ? <div className="muted small">正在写：第{cnNum(batch.current.idx)}章《{batch.current.title || '未命名'}》</div> : null}
              {batchText ? <div className="batch-stream">{batchText}</div> : null}
              {batchLog.length > 0 && (
                <div className="batch-log">
                  {batchLog.map((l, i) => (
                    <div key={i} className="batch-log-item">
                      <span className={`dot ${l.skipped ? 'planned' : 'done'}`} />
                      <span>第{cnNum(l.idx)}章《{l.title || '未命名'}》</span>
                      {l.skipped ? (
                        <span className="muted small">已有正文，已跳过</span>
                      ) : (
                        <>
                          <span className="muted small">{l.wordCount} 字</span>
                          {l.synced > 0 ? <span className="muted small">状态 {l.synced} 项</span> : null}
                          {l.reviewScore != null ? <Badge tone={l.reviewScore >= 85 ? 'ok' : l.reviewScore >= 70 ? 'warn' : 'accent'}>{l.reviewScore} 分</Badge> : null}
                          {l.revised ? <Badge tone="accent">已修文</Badge> : null}
                          {l.flavorScore != null ? <Badge tone={l.flavorScore >= 70 ? 'accent' : l.flavorScore >= 40 ? 'warn' : 'ok'}>AI腔 {l.flavorScore}</Badge> : null}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <ErrorNote error={batchErr} />
            </div>
          )}

          {preview && (
            <div style={{ padding: '0 14px 14px' }}>
              <div className="preview-panel">
                <div className="preview-head">
                  <span>{preview.mode === 'write' ? '整章生成结果' : preview.mode === 'continue' ? '续写结果' : '改写结果'}{preview.streaming ? '（流式输出中…）' : ''}</span>
                  <span className="grow" />
                  {!preview.streaming && (
                    <>
                      <button className="btn primary small" onClick={acceptPreview}>
                        {preview.mode === 'write' ? '替换本章正文' : preview.mode === 'continue' ? '插入到断点' : '替换选中片段'}
                      </button>
                      <button className="btn ghost small" onClick={() => setPreview(null)}>放弃</button>
                    </>
                  )}
                </div>
                <div className="preview-body">{preview.text}</div>
              </div>
            </div>
          )}
        </div>
        <ErrorNote error={err} />
        {note && <div className="hint-box mt8">{note}</div>}
      </section>

      {/* 右：任务与检查 */}
      <aside className="writer-aside">
        <div className="aside-card">
          <h4>本章任务 {vol ? <Badge>{vol.title}</Badge> : null}</h4>
          <div className="kv">
            <div><b>任务</b><span className="aside-text">{ch.brief || '（未填写）'}</span></div>
            {ch.scenes ? <div className="mt8"><b>场景</b><span className="aside-text">{ch.scenes}</span></div> : null}
            {ch.hook ? <div className="mt8"><b>钩子</b><span className="aside-text">{ch.hook}</span></div> : null}
            <div className="mt8"><b>目标</b>约 {project.type === 'short' && project.target_words ? Math.round(project.target_words / Math.max(1, project.chapters.length)) : 2600} 字</div>
          </div>
          <div className="mt8">
            <Link className="btn ghost small" to={`/p/${pid}/plan`}>在架构规划中编辑 →</Link>
          </div>
        </div>

        <div className="aside-card">
          <h4>出场人物</h4>
          {castChars.length === 0 ? (
            <span className="muted small">任务单未绑定人物，或人物不在角色库。</span>
          ) : (
            castChars.map((c) => (
              <div key={c.id} className="mt8">
                <div className="row" style={{ gap: 6 }}>
                  <b style={{ fontSize: 13 }}>{c.name}</b>
                  <Badge>{c.role}</Badge>
                </div>
                <div className="muted small" style={{ marginTop: 2, lineHeight: 1.7 }}>{c.status || c.profile?.slice(0, 40) || '—'}</div>
              </div>
            ))
          )}
        </div>

        <div className="aside-card">
          <h4>本章摘要</h4>
          {ch.summary ? (
            <div className="aside-text">{ch.summary}</div>
          ) : (
            <span className="muted small">正文写完后点「写后整理」，AI 会把本章发生的事压成摘要 —— 它会成为后续章节的长期记忆。</span>
          )}
        </div>

        <div className="aside-card">
          <h4>
            伏笔线索
            <Link className="muted small" to={`/p/${pid}/threads`}>管理 →</Link>
          </h4>
          {openThreads.length === 0 ? (
            <span className="muted small">暂无进行中的伏笔。写后整理会自动记录新埋与回收的线索。</span>
          ) : (
            openThreads.slice(0, 6).map((t) => (
              <div key={t.id} className="mt8">
                <div className="row" style={{ gap: 6 }}>
                  <span className={`thread-status thread-status-${t.status}`}>{THREAD_STATUS_NAMES[t.status]}</span>
                  <b style={{ fontSize: 12.5 }}>{t.name}</b>
                </div>
                {t.detail ? <div className="muted small" style={{ marginTop: 2, lineHeight: 1.7 }}>{t.detail}</div> : null}
              </div>
            ))
          )}
          {openThreads.length > 6 ? <div className="muted small mt8">还有 {openThreads.length - 6} 条…</div> : null}
        </div>

        <div className="aside-card">
          <h4>
            检查结果
            {review ? <Badge tone={review.score >= 85 ? 'ok' : review.score >= 70 ? 'warn' : 'accent'}>{review.score} 分</Badge> : null}
          </h4>
          {!review ? (
            <span className="muted small">写完正文后，让 AI 编辑做一次质检：任务完成度、一致性、文风与节奏。</span>
          ) : (
            <>
              <div className="row" style={{ gap: 10, marginBottom: 4 }}>
                <span className="review-score">{review.score}</span>
                <span className="muted small grow" style={{ lineHeight: 1.7 }}>{review.summary}</span>
              </div>
              {review.issues.map((it, i) => (
                <div key={i} className={`issue ${it.severity}`}>
                  <div className="issue-head">
                    <Badge tone={it.severity === 'high' ? 'accent' : it.severity === 'medium' ? 'warn' : 'info'}>{it.type}</Badge>
                    {it.location ? <span className="muted small">{it.location}</span> : null}
                  </div>
                  <div>{it.problem}</div>
                  {it.suggestion ? <div className="suggestion">建议：{it.suggestion}</div> : null}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="aside-card">
          <h4>生成约定</h4>
          <div className="muted small" style={{ lineHeight: 1.8 }}>
            正文生成会自动注入：本书创作约定、世界手册设定、出场人物卡与当前状态、全局与本书的写法规则及反 AI 规则、进行中的伏笔线索、最近章节摘要与上一章结尾。
            规则可在「写法规则」页调整。
          </div>
        </div>
      </aside>

      {historyOpen && (
        <Modal title={`历史版本 · 第${cnNum(ch.idx)}章`} wide onClose={() => { setHistoryOpen(false); setRevPreview(null); }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="muted small">自动保存最多保留最近 80 个版本（60 秒内合并），回滚会先为当前正文留档。</span>
            <span className="grow" />
            <button className="btn small" onClick={saveManualRevision}>当前正文存档</button>
          </div>
          {busyRev && revisions === null ? (
            <div className="loading-block"><Spinner text="读取版本…" /></div>
          ) : !revisions || revisions.length === 0 ? (
            <span className="muted small">还没有历史版本。保存或生成正文后会自动产生版本。</span>
          ) : (
            <div className="revision-list">
              {revisions.map((rv) => (
                <div
                  key={rv.id}
                  className={`revision-row ${revPreview?.rev.id === rv.id ? 'on' : ''}`}
                  onClick={() => previewRevision(rv)}
                >
                  <span className="revision-time">{fmtTime(rv.created_at)}</span>
                  <Badge>{REVISION_REASON_NAMES[rv.reason] || rv.reason}</Badge>
                  <span className="muted small">{rv.word_count} 字</span>
                  <span className="revision-preview muted small">{rv.preview}</span>
                </div>
              ))}
            </div>
          )}
          {revPreview && (
            <div className="rev-preview">
              <div className="row">
                <span className="muted small">{fmtTime(revPreview.rev.created_at)} 的版本 · {revPreview.rev.word_count} 字</span>
                <span className="grow" />
                <button className="btn primary small" disabled={busyRev} onClick={restoreRevision}>回滚到此版本</button>
              </div>
              <div className="rev-preview-body">{revPreview.content}</div>
            </div>
          )}
          <ErrorNote error={err} />
        </Modal>
      )}

      {batchOpen && (
        <Modal title="批量连写 · 让 AI 连续推进" onClose={() => setBatchOpen(false)} wide>
          <p className="muted small" style={{ lineHeight: 1.8, marginBottom: 12 }}>
            在所选范围内逐章生成 → 保存 → 写后整理（摘要 / 角色状态 / 伏笔）→ 检查。每章都会落库，可随时暂停、继续或取消；关掉页面任务仍在后台推进。
          </p>
          <div className="grid grid-2">
            <Field label="起始章">
              <select value={batchForm.from} onChange={(e) => setBatchForm({ ...batchForm, from: Number(e.target.value) })}>
                {project.chapters.map((c) => <option key={c.id} value={c.idx}>第{cnNum(c.idx)}章 · {c.title || '未命名'}{c.word_count > 0 ? '（已有正文）' : ''}</option>)}
              </select>
            </Field>
            <Field label="结束章">
              <select value={batchForm.to} onChange={(e) => setBatchForm({ ...batchForm, to: Number(e.target.value) })}>
                {project.chapters.map((c) => <option key={c.id} value={c.idx}>第{cnNum(c.idx)}章 · {c.title || '未命名'}</option>)}
              </select>
            </Field>
          </div>
          <div className="row-wrap" style={{ gap: 18, marginBottom: 12 }}>
            <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={batchForm.sync} onChange={(e) => setBatchForm({ ...batchForm, sync: e.target.checked })} />
              每章写后整理资料
            </label>
            <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={batchForm.review} onChange={(e) => setBatchForm({ ...batchForm, review: e.target.checked })} />
              每章自动检查
            </label>
            <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={batchForm.overwrite} onChange={(e) => setBatchForm({ ...batchForm, overwrite: e.target.checked })} />
              覆盖已有正文
            </label>
          </div>
          {batchForm.to < batchForm.from ? <span className="muted small">结束章需不早于起始章。</span> : null}
          <div className="muted small" style={{ marginBottom: 8 }}>
            将处理第 {cnNum(batchForm.from)}—{cnNum(batchForm.to)} 章，共 {Math.max(0, batchForm.to - batchForm.from + 1)} 章；已有正文的章节默认跳过，可勾选「覆盖已有正文」。
          </div>
          <ErrorNote error={batchErr} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
            <button className="btn ghost" onClick={() => setBatchOpen(false)}>取消</button>
            <button className="btn primary" disabled={batchForm.to < batchForm.from} onClick={startBatch}>开始连写</button>
          </div>
        </Modal>
      )}

      {rewriteModal && (
        <Modal title="改写选中片段" onClose={() => setRewriteModal(null)}>
          <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 7, padding: '10px 12px', fontFamily: 'var(--serif)', fontSize: 13, lineHeight: 1.9, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {rewriteModal.selection}
          </div>
          <Field label="改写要求">
            <textarea
              autoFocus
              rows={2}
              placeholder="例：更冷峻克制，去掉解释性语句，加强动作细节"
              value={rewriteModal.instruction}
              onChange={(e) => setRewriteModal({ ...rewriteModal, instruction: e.target.value })}
            />
          </Field>
          <ErrorNote error={err} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setRewriteModal(null)}>取消</button>
            <button className="btn primary" onClick={genRewrite}>开始改写</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
