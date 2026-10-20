import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, STATUS_NAMES, fmtTime } from '../api';
import { Modal, Field, Badge, ErrorNote, Empty } from '../components/ui';
import type { ProjectSummary } from '../types';

export default function Bookshelf() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const load = () => api.get('/projects').then(setProjects).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const openDemo = async () => {
    setSeeding(true);
    setErr(null);
    try {
      const r = await api.post('/demo', {});
      await load();
      nav(`/p/${r.project.id}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>我的书架</h1>
          <div className="sub">人管控、AI 管写 —— 从一句灵感，到一本有骨架、有世界、有正文的书。</div>
        </div>
        <div className="row">
          <button className="btn" disabled={seeding} onClick={openDemo} title="内置一本完整示例书，含世界、角色、卷纲、正文、伏笔、版本与码字统计">
            {seeding ? '载入中…' : '载入示例作品'}
          </button>
          <button className="btn primary big" onClick={() => setShowNew(true)}>＋ 新建作品</button>
        </div>
      </div>
      <ErrorNote error={err} onRetry={load} />
      {projects === null ? (
        <div className="loading-block"><span className="spinner" /></div>
      ) : projects.length === 0 ? (
        <Empty
          title="书架还是空的"
          desc="点击「新建作品」，写下你脑子里那句话 —— 哪怕只是一个画面、一句台词。剩下的骨架，我们一步一步搭。也可以先载入示例作品看看完整形态。"
          action={
            <div className="row">
              <button className="btn primary" onClick={() => setShowNew(true)}>写下第一句灵感</button>
              <button className="btn" disabled={seeding} onClick={openDemo}>{seeding ? '载入中…' : '载入示例作品'}</button>
            </div>
          }
        />
      ) : (
        <div className="book-grid">
          {projects.map((p) => (
            <div key={p.id} className="book-card" onClick={() => nav(`/p/${p.id}`)}>
              <div className="row">
                <span className="book-title grow">{p.title}</span>
                <Badge tone={p.type === 'short' ? 'info' : 'default'}>{p.type === 'short' ? '短篇' : '长篇'}</Badge>
              </div>
              <div className="book-meta">
                <Badge tone="accent">{STATUS_NAMES[p.status] || p.status}</Badge>
                {p.direction ? <span className="chip">{p.direction.genre}</span> : null}
              </div>
              <div className="muted small" style={{
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{p.direction?.logline || p.premise}</div>
              <div className="book-foot">
                <span>{p.chapters_done}/{p.chapters_total} 章 · {(p.word_total / 10000).toFixed(1)} 万字</span>
                <span>{fmtTime(p.updated_at)}</span>
              </div>
            </div>
          ))}
          <div className="book-card book-new" onClick={() => setShowNew(true)}>
            <span className="plus">＋</span>
            <span>从一句灵感开一本新书</span>
          </div>
        </div>
      )}
      {showNew && (
        <NewBookModal
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); nav(`/p/${id}/direction`); }}
        />
      )}
    </main>
  );
}

function NewBookModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [premise, setPremise] = useState('');
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'novel' | 'short'>('novel');
  const [targetWords, setTargetWords] = useState(12000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!premise.trim()) { setErr('请先写下你的灵感'); return; }
    setBusy(true); setErr(null);
    try {
      const p = await api.post('/projects', { premise, title, type, targetWords: type === 'short' ? targetWords : 0 });
      onCreated(p.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建作品 · 从一句灵感开始" onClose={onClose}>
      <Field label="灵感" hint="一句话即可：一个人物、一个冲突、一个画面">
        <textarea
          autoFocus
          rows={3}
          placeholder="例：一个能听见死者执念的点灯人，在戒严的城市里追查三十年前全城灯火熄灭之谜"
          value={premise}
          onChange={(e) => setPremise(e.target.value)}
        />
      </Field>
      <Field label="作品名" hint="留空可让 AI 在定方向时命名">
        <input type="text" placeholder="未命名作品" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="形态">
        <div className="radio-row">
          <div className={`radio-card ${type === 'novel' ? 'on' : ''}`} onClick={() => setType('novel')}>
            <div className="radio-title">长篇连载</div>
            <div className="radio-desc">卷纲 → 逐章推进，可持续写几十万字</div>
          </div>
          <div className={`radio-card ${type === 'short' ? 'on' : ''}`} onClick={() => setType('short')}>
            <div className="radio-title">短篇</div>
            <div className="radio-desc">一次读完、有完整结局</div>
          </div>
        </div>
      </Field>
      {type === 'short' && (
        <Field label="目标字数">
          <select value={targetWords} onChange={(e) => setTargetWords(Number(e.target.value))}>
            <option value={3000}>约 3,000 字</option>
            <option value={6000}>约 6,000 字</option>
            <option value={12000}>约 12,000 字</option>
            <option value={30000}>约 30,000 字</option>
          </select>
        </Field>
      )}
      <ErrorNote error={err} />
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy} onClick={submit}>{busy ? '创建中…' : '创建并进入向导'}</button>
      </div>
    </Modal>
  );
}
