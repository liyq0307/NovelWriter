import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Spinner, ErrorNote } from '../components/ui';
import type { Direction } from '../types';

export default function Directions() {
  const { project, reload } = useProject();
  const [candidates, setCandidates] = useState<Direction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const nav = useNavigate();

  const d = project.direction;

  const generate = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const arr: Direction[] = await api.post(`/projects/${project.id}/directions`);
      setCandidates(arr);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const choose = async (dir: Direction) => {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/projects/${project.id}`, {
        direction: dir,
        contract: dir.contract,
        status: 'direction',
        title: project.title === '未命名作品' ? dir.title : project.title,
      });
      await reload();
      setNote(`已选定《${dir.title}》——接下来去「世界手册」搭世界、「角色库」立人物。`);
      setCandidates(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {note && <div className="hint-box" style={{ marginBottom: 16 }}>{note} <button className="btn small" onClick={() => nav('/p/' + project.id)}>回概览</button></div>}

      {d && (
        <div className="card dir-card dir-picked" style={{ marginBottom: 20 }}>
          <div className="row-wrap">
            <span className="dir-title">《{d.title}》</span>
            <Badge tone="accent">{d.genre}</Badge>
            <Badge>当前方向</Badge>
          </div>
          <div className="dir-logline">{d.logline}</div>
          <div className="row-wrap">
            {d.sellingPoints?.map((s, i) => <span key={i} className="chip">{s}</span>)}
          </div>
          <div className="kv mt8">
            <div><b>主角</b>{d.protagonist}</div>
            <div><b>文风</b>{d.style}</div>
            <div><b>读者</b>{d.audience}</div>
          </div>
          <div className="row mt8">
            <button className="btn small" disabled={busy} onClick={generate}>{busy ? <Spinner /> : '重新生成候选方向'}</button>
          </div>
        </div>
      )}

      {!d && !busy && candidates === null && (
        <div className="card" style={{ textAlign: 'center', padding: '40px 20px' }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 20, marginBottom: 8 }}>一句灵感，三个方向</div>
          <p className="muted" style={{ maxWidth: 480, margin: '0 auto 20px', lineHeight: 1.8 }}>
            AI 会基于你的灵感给出三个差异明显的候选方向：题材赛道、情绪基调、叙事方式各不相同。
            选定后即生成本书的「创作约定」（视角 / 基调 / 禁忌 / 弧线），后续所有生成都会遵守。
          </p>
          <button className="btn primary big" onClick={generate}>AI 生成候选方向</button>
        </div>
      )}

      {busy && (
        <div className="card loading-block"><Spinner text="正在基于灵感策划三个方向…" /></div>
      )}

      <ErrorNote error={err} onRetry={generate} />

      {candidates && (
        <div className="grid grid-3">
          {candidates.map((c, i) => (
            <div key={i} className="card dir-card">
              <div className="row-wrap">
                <span className="dir-title">{c.title}</span>
                <Badge tone="accent">{c.genre}</Badge>
              </div>
              <div className="dir-logline">{c.logline}</div>
              <div className="row-wrap">
                {c.sellingPoints?.slice(0, 3).map((s, j) => <span key={j} className="chip">{s}</span>)}
              </div>
              <div className="kv">
                <div><b>主角</b>{c.protagonist}</div>
                <div><b>文风</b>{c.style}</div>
                <div><b>读者</b>{c.audience}</div>
              </div>
              <div className="mt8">
                <button className="btn primary" disabled={busy} onClick={() => choose(c)}>选定此方向</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
