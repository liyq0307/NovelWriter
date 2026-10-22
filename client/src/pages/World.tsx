import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Modal, Field, Spinner, ErrorNote, Empty, ConfirmButton } from '../components/ui';
import type { WorldEntry } from '../types';

const CATS = ['地理', '势力', '规则', '物品', '历史', '其他'];
const CAT_GLYPH: Record<string, string> = { 地理: '山', 势力: '旗', 规则: '律', 物品: '器', 历史: '卷', 其他: '杂' };
const FACT_KINDS = ['世界规则', '时间线', '人物', '剧情'];
const FACT_TONE: Record<string, 'accent' | 'info' | 'ok' | 'warn' | 'default'> = {
  世界规则: 'accent',
  时间线: 'info',
  人物: 'ok',
  剧情: 'default',
};
const FACT_PAGE = 15;

type Tab = 'world' | 'facts';

export default function World() {
  const { project, reload } = useProject();
  const [tab, setTab] = useState<Tab>('world');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [kind, setKind] = useState('all');
  const [factLimit, setFactLimit] = useState(FACT_PAGE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<WorldEntry> | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const world = project.world || [];
  const facts = project.facts || [];
  const query = q.trim().toLowerCase();
  const hit = (s?: string | null) => !query || String(s || '').toLowerCase().includes(query);

  const catCounts: Record<string, number> = {};
  for (const w of world) catCounts[w.category] = (catCounts[w.category] || 0) + 1;
  const kindCounts: Record<string, number> = {};
  for (const f of facts) kindCounts[f.kind] = (kindCounts[f.kind] || 0) + 1;

  const cats = CATS.filter((c) => catCounts[c] > 0 || cat === c);
  const kinds = FACT_KINDS.filter((k) => kindCounts[k] > 0 || kind === k);

  const catOrder = (c: string) => {
    const i = CATS.indexOf(c);
    return i < 0 ? CATS.length : i;
  };
  const sortedWorld = [...world].sort((a, b) => catOrder(a.category) - catOrder(b.category) || a.id - b.id);

  const visibleWorld = sortedWorld.filter((w) => (cat === 'all' || w.category === cat) && (hit(w.name) || hit(w.content) || hit(w.category)));
  const visibleFacts = facts.filter((f) => (kind === 'all' || f.kind === kind) && (hit(f.fact) || hit(f.subject) || hit(f.kind)));
  const filtering = tab === 'world' ? (!!query || cat !== 'all') : (!!query || kind !== 'all');

  const switchTab = (t: Tab) => {
    setTab(t);
    setQ('');
    setFactLimit(FACT_PAGE);
    setErr(null);
  };

  const generate = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await api.post(`/projects/${project.id}/world/generate`);
      await reload();
      setQ('');
      setCat('all');
      setNote(`AI 新增了 ${r.added} 条设定（已自动跳过与现有条目重名的内容）。`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setErr('条目名不能为空'); return; }
    const isNew = !editing.id;
    try {
      if (editing.id) {
        await api.put(`/projects/${project.id}/world/${editing.id}`, editing);
      } else {
        await api.post(`/projects/${project.id}/world`, editing);
      }
      setEditing(null);
      await reload();
      if (isNew) { setQ(''); setCat('all'); }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const dedupeFacts = async () => {
    setErr(null); setNote(null);
    try {
      const r = await api.post(`/projects/${project.id}/facts/dedupe`);
      await reload();
      setNote(r.removed > 0
        ? `已合并 ${r.removed} 条表述重复的事实，现有 ${r.kept} 条。`
        : '没有发现可以合并的重复事实。');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const clearWorldFilter = () => { setQ(''); setCat('all'); };
  const clearFactFilter = () => { setQ(''); setKind('all'); setFactLimit(FACT_PAGE); };

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 14 }}>
        <span className="muted small">
          {tab === 'world'
            ? '世界手册里的每一条设定，都会注入正文生成的上下文 —— 规则明确，AI 才不越界。'
            : '这些事实由写后整理自动抽取，生成与检查时用来防止前后矛盾；表述重复的可以一键合并。'}
        </span>
        <span className="grow" />
        {tab === 'world' ? (
          <>
            <button className="btn" onClick={() => { setEditing({ category: '其他' }); setErr(null); }}>＋ 手动新增</button>
            <button className="btn primary" disabled={busy} onClick={generate}>{busy ? <><Spinner /> AI 起草中…</> : 'AI 起草设定'}</button>
          </>
        ) : null}
      </div>

      {note && <div className="hint-box" style={{ marginBottom: 14 }}>{note}</div>}
      <ErrorNote error={err} />

      <div className="row-wrap" style={{ marginBottom: 14 }}>
        <div className="seg">
          <button className={tab === 'world' ? 'on' : ''} onClick={() => switchTab('world')}>
            世界设定 <span className="seg-count">{world.length}</span>
          </button>
          <button className={tab === 'facts' ? 'on' : ''} onClick={() => switchTab('facts')}>
            既定事实 <span className="seg-count">{facts.length}</span>
          </button>
        </div>
        <span className="grow" />
        {filtering ? (
          <span className="muted small">
            筛选出 {tab === 'world' ? visibleWorld.length : visibleFacts.length} 条
          </span>
        ) : null}
      </div>

      {tab === 'world' ? (
        <>
          {world.length > 0 && (
            <div className="world-tools">
              <div className="row-wrap" style={{ gap: 6 }}>
                <button className={`chip chip-btn ${cat === 'all' ? 'active' : ''}`} onClick={() => setCat('all')}>
                  全部<span className="chip-count">{world.length}</span>
                </button>
                {cats.map((c) => (
                  <button key={c} className={`chip chip-btn ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>
                    {c}<span className="chip-count">{catCounts[c] || 0}</span>
                  </button>
                ))}
              </div>
              <span className="grow" />
              <input
                type="text"
                className="world-search"
                value={q}
                placeholder="搜索设定名或内容…"
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          )}

          {world.length === 0 ? (
            busy ? (
              <div className="loading-block"><Spinner text="AI 正在起草世界设定…" /></div>
            ) : (
              <Empty
                title="世界还是一片空白"
                desc="让 AI 基于已定方向起草：地理舞台、势力立场、世界规则（含能力边界与代价）、关键物品与历史暗线。"
              />
            )
          ) : visibleWorld.length === 0 ? (
            <Empty
              title="没有匹配的设定"
              desc="换个关键词，或清除分类筛选再看看。"
              action={<button className="btn" onClick={clearWorldFilter}>清除筛选</button>}
            />
          ) : (
            <div className="world-grid">
              {visibleWorld.map((w) => (
                <article key={w.id} className="card world-card">
                  <div className="world-card-head">
                    <span className="world-glyph">{CAT_GLYPH[w.category] || '杂'}</span>
                    <b className="world-name">{w.name}</b>
                    <span className="chip world-cat">{w.category}</span>
                    {w.source === 'human' ? <Badge tone="info">手写</Badge> : <Badge>AI</Badge>}
                    <span className="grow" />
                    <div className="world-actions">
                      <button className="btn ghost small" onClick={() => setEditing(w)}>编辑</button>
                      <ConfirmButton
                        className="btn ghost small"
                        onConfirm={async () => { await api.del(`/projects/${project.id}/world/${w.id}`); await reload(); }}
                      >
                        删除
                      </ConfirmButton>
                    </div>
                  </div>
                  <p className="world-content">{w.content}</p>
                </article>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {facts.length > 0 && (
            <div className="world-tools">
              <div className="row-wrap" style={{ gap: 6 }}>
                <button className={`chip chip-btn ${kind === 'all' ? 'active' : ''}`} onClick={() => { setKind('all'); setFactLimit(FACT_PAGE); }}>
                  全部<span className="chip-count">{facts.length}</span>
                </button>
                {kinds.map((k) => (
                  <button key={k} className={`chip chip-btn ${kind === k ? 'active' : ''}`} onClick={() => { setKind(k); setFactLimit(FACT_PAGE); }}>
                    {k}<span className="chip-count">{kindCounts[k] || 0}</span>
                  </button>
                ))}
              </div>
              <span className="grow" />
              <input
                type="text"
                className="world-search"
                value={q}
                placeholder="搜索主体或事实…"
                onChange={(e) => { setQ(e.target.value); setFactLimit(FACT_PAGE); }}
              />
              <ConfirmButton className="btn small" onConfirm={dedupeFacts}>合并重复</ConfirmButton>
            </div>
          )}

          {facts.length === 0 ? (
            <Empty
              title="还没有沉淀事实"
              desc="写完一章并做写后整理后，死亡、受伤、得失、抵达这类硬事实会自动记到这里。"
              action={<Link className="btn" to={`/p/${project.id}/write`}>去写作台</Link>}
            />
          ) : visibleFacts.length === 0 ? (
            <Empty
              title="没有匹配的事实"
              desc="换个关键词，或切换到其他事实类型。"
              action={<button className="btn" onClick={clearFactFilter}>清除筛选</button>}
            />
          ) : (
            <div className="card fact-panel">
              {visibleFacts.slice(0, factLimit).map((f) => (
                <div key={f.id} className="fact-row">
                  <div className="fact-main">
                    <div className="fact-head">
                      <Badge tone={FACT_TONE[f.kind] || 'default'}>{f.kind}</Badge>
                      {f.subject ? <b className="fact-subject">{f.subject}</b> : null}
                      {f.chapter_idx ? <span className="muted small">第 {f.chapter_idx} 章</span> : null}
                    </div>
                    <div className="fact-text">{f.fact}</div>
                  </div>
                  <ConfirmButton
                    className="btn ghost small"
                    onConfirm={async () => { await api.del(`/projects/${project.id}/facts/${f.id}`); await reload(); }}
                  >
                    删除
                  </ConfirmButton>
                </div>
              ))}
              {visibleFacts.length > factLimit && (
                <div className="fact-more">
                  <button className="btn ghost small" onClick={() => setFactLimit(factLimit + FACT_PAGE)}>
                    显示更多（还有 {visibleFacts.length - factLimit} 条）
                  </button>
                </div>
              )}
            </div>
          )}
        </>
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
