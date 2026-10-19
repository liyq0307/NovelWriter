import { Link, useNavigate } from 'react-router-dom';
import { cnNum, STATUS_NAMES } from '../api';
import { useProject } from './ProjectPage';
import { Badge } from '../components/ui';

export default function Overview() {
  const { project } = useProject();
  const nav = useNavigate();
  const d = project.direction;
  const ct = project.contract;
  const done = project.chapters.filter((c) => c.word_count > 0);
  const recent = [...project.chapters].sort((a, b) => b.idx - a.idx).slice(0, 5);
  const target = project.target_words || 0;
  const pct = target ? Math.min(100, Math.round((project.word_total / target) * 100)) : 0;

  const steps = [
    { key: 'direction', label: '定方向', done: !!d, to: 'direction' },
    { key: 'world', label: '搭世界', done: project.world.length > 0, to: 'world' },
    { key: 'characters', label: '立人物', done: project.characters.length > 0, to: 'characters' },
    { key: 'plan', label: '架构与拆章', done: project.chapters.length > 0, to: 'plan' },
    { key: 'write', label: '成正文', done: done.length > 0, to: 'write' },
  ];
  const currentIdx = steps.findIndex((s) => !s.done);

  return (
    <div>
      <div className="stepper">
        {steps.map((s, i) => (
          <div key={s.key} className={`step ${s.done ? 'done' : ''} ${i === currentIdx ? 'current' : ''}`}>
            <span className="step-idx">{s.done ? '✓' : i + 1}</span>
            <Link to={s.to}>{s.label}</Link>
          </div>
        ))}
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-num">{project.word_total}<em>字</em></div>
          <div className="stat-label">已写正文{target ? ` · 目标 ${(target / 10000).toFixed(1)} 万字（${pct}%）` : ''}</div>
          {target ? <div className="progress"><div style={{ width: `${pct}%` }} /></div> : null}
        </div>
        <div className="stat">
          <div className="stat-num">{done.length}<em>/{project.chapters.length} 章</em></div>
          <div className="stat-label">章节进度</div>
        </div>
        <div className="stat">
          <div className="stat-num">{project.world.length}<em>条</em></div>
          <div className="stat-label">世界设定</div>
        </div>
        <div className="stat">
          <div className="stat-num">{project.characters.length}<em>人</em></div>
          <div className="stat-label">角色卡 · {project.relations.length} 组关系</div>
        </div>
      </div>

      <div className="grid grid-2 mt16">
        <div className="card">
          <div className="card-title">本书方向</div>
          {d ? (
            <>
              <div className="row-wrap">
                <span style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>{d.title}</span>
                <Badge tone="accent">{d.genre}</Badge>
                <Badge>{d.audience}</Badge>
              </div>
              <p className="mt8" style={{ lineHeight: 1.8, color: 'var(--ink-2)' }}>{d.logline}</p>
              <div className="row-wrap mt8">
                {d.sellingPoints?.map((s, i) => <span key={i} className="chip">{s}</span>)}
              </div>
              <div className="mt16">
                <Link className="btn small" to="direction">查看 / 更换方向</Link>
              </div>
            </>
          ) : (
            <div className="empty" style={{ padding: '18px 0' }}>
              <div className="empty-title">还没有确定方向</div>
              <div className="empty-desc">让 AI 基于你的灵感给出三个差异明显的候选方向：题材、基调、叙事方式各不相同。</div>
              <div className="empty-action"><button className="btn primary" onClick={() => nav('direction')}>去定方向</button></div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">创作约定</div>
          {ct ? (
            <div className="kv">
              <div><b>视角</b>{ct.pov || '—'}</div>
              <div><b>基调</b>{ct.tone || '—'}</div>
              <div><b>弧线</b>{ct.arc || '—'}</div>
              {ct.taboos?.length ? <div><b>避免</b>{ct.taboos.join('、')}</div> : null}
            </div>
          ) : (
            <p className="muted small" style={{ lineHeight: 1.8 }}>确定方向后会生成视角、基调与禁忌等约定，正文生成将全程遵守。</p>
          )}
          <div className="mt16 kv">
            <div><b>灵感</b><span style={{ fontFamily: 'var(--serif)' }}>「{project.premise}」</span></div>
          </div>
        </div>
      </div>

      <div className="card mt16">
        <div className="card-title">最近章节</div>
        {recent.length === 0 ? (
          <p className="muted small">还没有章节。去「架构规划」让 AI 生成卷纲并拆章。</p>
        ) : (
          <table className="table">
            <thead><tr><th style={{ width: 60 }}>章</th><th>章节名</th><th style={{ width: 90 }}>状态</th><th style={{ width: 80 }}>字数</th><th style={{ width: 70 }} /></tr></thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.id}>
                  <td className="muted">第{cnNum(c.idx)}章</td>
                  <td>{c.title || '（未命名）'}</td>
                  <td><span className="row" style={{ gap: 6 }}><span className={`dot ${c.status}`} />{c.status === 'planned' ? '待写' : c.status === 'draft' ? '草稿' : '完成'}</span></td>
                  <td className="muted">{c.word_count}</td>
                  <td><Link to={`write/${c.id}`}>写作 →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
