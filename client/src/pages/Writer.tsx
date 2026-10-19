import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, sse, countWords, cnNum } from '../api';
import { useProject } from './ProjectPage';
import { Modal, Field, Spinner, ErrorNote, Empty, ConfirmButton, Badge } from '../components/ui';
import type { Chapter, Review } from '../types';

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

  const taRef = useRef<HTMLTextAreaElement>(null);
  const posRef = useRef({ start: 0, end: 0 });

  /* 选中章节：URL 参数或自动选第一章 */
  useEffect(() => {
    if (project.chapters.length === 0) return;
    const target = chapterId ? Number(chapterId) : project.chapters[0].id;
    if (!chapterId) nav(`/p/${pid}/write/${target}`, { replace: true });
  }, [project.chapters, chapterId, pid, nav]);

  useEffect(() => {
    if (!chapterId) return;
    let alive = true;
    api.get(`/projects/${pid}/chapters/${chapterId}`).then((c: Chapter) => {
      if (!alive) return;
      setCh(c);
      setContent(c.content || '');
      setSaveState('idle');
      setPreview(null);
      setNote(null);
      setErr(null);
    }).catch((e) => setErr(e.message));
    return () => { alive = false; };
  }, [pid, chapterId]);

  /* 自动保存（防抖 900ms） */
  const doSave = useCallback(async (text: string, sync = false) => {
    const r = await api.put(`/projects/${pid}/chapters/${chapterId}/content${sync ? '?sync=1' : ''}`, { content: text });
    if (sync && r.synced?.length) {
      setNote(`已同步角色状态：${r.synced.map((s: any) => s.name).join('、')}`);
      await reload();
    }
    return r;
  }, [pid, chapterId, reload]);

  useEffect(() => {
    if (!ch) return;
    if (streaming) return;
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
            await doSave(finalText, true);
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
      await doSave(next, preview.mode === 'write');
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
      setNote(r.updated?.length ? `已同步角色状态：${r.updated.map((s: any) => s.name).join('、')}` : 'AI 判断本章没有角色状态变化。');
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
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} disabled={!!streaming} />
              跟随写入
            </label>
            <button className="btn primary small" disabled={!!streaming} onClick={genChapter}>
              {streaming === 'write' ? <><span className="pulse spin" />生成中…</> : ch.content ? '重新生成本章' : 'AI 生成本章'}
            </button>
            <button className="btn small" disabled={!!streaming} onClick={genContinue}>光标续写</button>
            <button className="btn small" disabled={!!streaming} onClick={openRewrite}>改写选中</button>
            <span className="grow" />
            <button className="btn small" disabled={busyReview || !!streaming} onClick={runReview}>{busyReview ? <Spinner /> : 'AI 检查本章'}</button>
            <button className="btn small" disabled={busySync || !!streaming || !ch.content} onClick={runSync}>{busySync ? <Spinner /> : '同步状态'}</button>
          </div>
          <textarea
            ref={taRef}
            className="editor-area"
            value={content}
            readOnly={!!streaming}
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
            正文生成会自动注入：本书创作约定、世界手册设定、出场人物卡与当前状态、全局与本书的写法规则及反 AI 规则、上一章结尾。
            规则可在「写法规则」页调整。
          </div>
        </div>
      </aside>

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
