import { useEffect, useRef, useState } from 'react';
import { api, fmtTime } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Spinner, ErrorNote, ConfirmButton } from '../components/ui';
import type { Deconstruction } from '../types';

export default function Deconstruct() {
  const { project, reload } = useProject();
  const [items, setItems] = useState<Deconstruction[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setItems(await api.get(`/projects/${project.id}/deconstructions`));
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => { load(); }, [project.id]);

  const onFile = async (f?: File) => {
    if (!f) return;
    const content = await f.text();
    setText(content);
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };

  const run = async () => {
    if (text.trim().length < 200) {
      setErr('请先粘贴或导入至少 200 字的参考正文');
      return;
    }
    setBusy(true); setErr(null); setNote(null);
    try {
      const d: Deconstruction = await api.post(`/projects/${project.id}/deconstructions`, { title: title.trim(), text });
      setItems((list) => [d, ...list]);
      setOpenId(d.id);
      setNote(`已拆解《${d.title}》：${d.chapter_count} 章 / ${d.word_count} 字`);
      setText('');
      setTitle('');
    } catch (e: any) {
      setErr(e.message);
      load();
    } finally {
      setBusy(false);
    }
  };

  const toRules = async (d: Deconstruction) => {
    try {
      const r = await api.post(`/projects/${project.id}/deconstructions/${d.id}/to-rules`);
      setNote(`已写入 ${r.added} 条写法规则${r.added ? '，去「写法规则」页可查看与停用' : '（同名规则已存在，跳过）'}`);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const remove = async (d: Deconstruction) => {
    await api.del(`/projects/${project.id}/deconstructions/${d.id}`);
    setItems((list) => list.filter((x) => x.id !== d.id));
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <div>
            <b>导入参考作品</b>
            <span className="muted small" style={{ marginLeft: 8 }}>拆结构、拆人物、拆写法，一键沉淀成本书可用的写法规则</span>
          </div>
          <button className="btn ghost small" onClick={() => fileRef.current?.click()}>读取 TXT / MD</button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => { onFile(e.target.files?.[0]); e.currentTarget.value = ''; }}
          />
        </div>
        <div className="mt16">
          <label className="field">
            <span className="field-label">作品名 <em className="field-hint">可选，用于标注拆解来源</em></span>
            <input type="text" value={title} placeholder="如《长夜行》" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">参考正文 <em className="field-hint">自动识别「第X章 / Chapter N」分章；识别不到时按篇幅切分</em></span>
            <textarea
              value={text}
              placeholder="粘贴参考作品正文，或点右上角读取本地文件……"
              style={{ minHeight: 180 }}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={run}>
              {busy ? <Spinner text="AI 正在通读并拆解…" /> : '开始拆书'}
            </button>
            {text && <span className="muted small">{text.replace(/\s/g, '').length} 字</span>}
          </div>
        </div>
      </div>

      {note && <div className="hint-box" style={{ marginBottom: 16 }}>{note}</div>}
      <ErrorNote error={err} onRetry={load} />

      {!items.length && !busy && (
        <div className="muted small" style={{ padding: '8px 2px' }}>
          还没有拆书记录。导入一部你喜欢的作品，AI 会给出结构模型、人物弧线、写法技巧与可注入的规则。
        </div>
      )}

      <div className="stack">
        {items.map((d) => {
          const r = d.result;
          const open = openId === d.id;
          return (
            <div key={d.id} className="card">
              <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <div className="row-wrap">
                  <b>《{d.title}》</b>
                  <Badge>{d.chapter_count} 章</Badge>
                  <Badge>{d.word_count} 字</Badge>
                  {d.status === 'done' && <Badge tone="ok">已拆解</Badge>}
                  {d.status === 'error' && <Badge tone="warn">失败</Badge>}
                  <span className="muted small">{fmtTime(d.created_at)}</span>
                </div>
                <div className="row">
                  <button className="btn ghost small" onClick={() => setOpenId(open ? null : d.id)}>{open ? '收起' : '查看结果'}</button>
                  {d.status === 'done' && (
                    <button className="btn small" onClick={() => toRules(d)}>转为写法规则</button>
                  )}
                  <ConfirmButton className="btn danger small" onConfirm={() => remove(d)}>删除</ConfirmButton>
                </div>
              </div>

              {d.error && <div className="error-note mt8">{d.error}</div>}

              {open && r && (
                <div className="mt16">
                  <div className="muted small">梗概</div>
                  <p style={{ lineHeight: 1.8 }}>{r.summary}</p>

                  <div className="grid grid-2 mt16">
                    <div>
                      <div className="muted small">结构模型</div>
                      <p><b>{r.structure.pattern || '—'}</b></p>
                      <ol style={{ paddingLeft: 18, lineHeight: 1.9 }}>
                        {r.structure.beats.map((b, i) => <li key={i}>{b}</li>)}
                      </ol>
                    </div>
                    <div>
                      <div className="muted small">写法画像</div>
                      <div className="kv mt8">
                        {r.style.pov && <div><b>视角</b>{r.style.pov}</div>}
                        {r.style.tone && <div><b>基调</b>{r.style.tone}</div>}
                        {r.style.sentence && <div><b>句式</b>{r.style.sentence}</div>}
                        {r.style.dialogue && <div><b>对话</b>{r.style.dialogue}</div>}
                        {r.style.description && <div><b>描写</b>{r.style.description}</div>}
                        {r.style.pacing && <div><b>节奏</b>{r.style.pacing}</div>}
                      </div>
                      {r.style.signature?.length > 0 && (
                        <div className="row-wrap mt8">
                          {r.style.signature.map((s, i) => <span key={i} className="chip">{s}</span>)}
                        </div>
                      )}
                    </div>
                  </div>

                  {r.characters.length > 0 && (
                    <div className="mt16">
                      <div className="muted small">人物弧线</div>
                      <div className="stack mt8">
                        {r.characters.map((c, i) => (
                          <div key={i} className="row-wrap" style={{ alignItems: 'baseline' }}>
                            <b>{c.name}</b>
                            <Badge>{c.role}</Badge>
                            <span className="small muted">欲望：{c.want || '—'}</span>
                            <span className="small muted">缺陷：{c.flaw || '—'}</span>
                            <span className="small muted">弧线：{c.arc || '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {r.techniques.length > 0 && (
                    <div className="mt16">
                      <div className="muted small">可复用技巧</div>
                      <ul style={{ paddingLeft: 18, lineHeight: 1.9 }}>
                        {r.techniques.map((t, i) => <li key={i}>{t}</li>)}
                      </ul>
                    </div>
                  )}

                  {r.rules.length > 0 && (
                    <div className="mt16">
                      <div className="muted small">建议规则（可一键写入）</div>
                      <div className="stack mt8">
                        {r.rules.map((rule, i) => (
                          <div key={i} className="row-wrap" style={{ alignItems: 'baseline' }}>
                            <Badge tone={rule.kind === 'anti_ai' ? 'warn' : 'info'}>{rule.kind === 'anti_ai' ? '反AI' : '写法'}</Badge>
                            <b>{rule.name}</b>
                            <span className="small muted">{rule.content}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <details className="mt16">
                    <summary className="muted small" style={{ cursor: 'pointer' }}>章节结构（{d.chapters.length} 章）</summary>
                    <div className="row-wrap mt8">
                      {d.chapters.map((c) => (
                        <span key={c.idx} className="chip">{c.idx}. {c.title} · {c.words}字</span>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
