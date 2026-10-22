import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { api } from '../api';
import { useProject } from './ProjectPage';
import { Badge, Modal, Field, Spinner, ErrorNote, Empty, ConfirmButton } from '../components/ui';
import type { Character, Relation } from '../types';

const ROLES = ['主角', '重要配角', '配角', '反派'];
const ROLE_TONE: Record<string, 'accent' | 'info' | 'default' | 'warn'> = { 主角: 'accent', 重要配角: 'info', 配角: 'default', 反派: 'warn' };

/* ============ 关系图 ============ */

const VB_W = 900;
const VB_H = 560;
const ROLE_COLOR: Record<string, string> = {
  主角: 'var(--accent)',
  重要配角: 'var(--info)',
  反派: 'var(--warn)',
  配角: 'var(--muted)',
};
const ROLE_FILL: Record<string, string> = {
  主角: 'var(--accent-soft)',
  重要配角: 'var(--info-soft)',
  反派: 'var(--warn-soft)',
  配角: 'var(--panel-2)',
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface SimNode extends SimulationNodeDatum {
  id: number;
  name: string;
  role: string;
  r: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  rel: Relation;
  bend: number;
}

const ROLE_R: Record<string, number> = { 主角: 34, 反派: 30, 重要配角: 28, 配角: 26 };

function RelGraph({ characters, relations }: { characters: Character[]; relations: Relation[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);

  const idsKey = characters.map((c) => c.id).join(',');
  const relKey = relations.map((r) => r.id).join(',');

  const byName = useMemo(() => {
    const m = new Map<string, Character>();
    for (const c of characters) m.set(c.name, c);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  /* 力导向布局：位置跨渲染保留，拖拽时固定节点（fx/fy），数据变化时重建仿真 */
  useEffect(() => {
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes: SimNode[] = characters.map((c, i) => {
      const old = prev.get(c.id);
      const ang = (i / Math.max(characters.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return {
        id: c.id, name: c.name, role: c.role, r: ROLE_R[c.role] ?? 26,
        x: old?.x ?? VB_W / 2 + 200 * Math.cos(ang),
        y: old?.y ?? VB_H / 2 + 160 * Math.sin(ang),
      };
    });
    const pairSeen = new Map<string, number>();
    const links: SimLink[] = [];
    for (const rel of relations) {
      const a = byName.get(rel.from_name);
      const b = byName.get(rel.to_name);
      if (!a || !b) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const idx = pairSeen.get(key) || 0;
      pairSeen.set(key, idx + 1);
      links.push({ rel, source: a.id, target: b.id, bend: (idx % 2 ? -1 : 1) * (1 + Math.floor(idx / 2)) });
    }
    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation<SimNode>(nodes)
      .force('link', forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance((l) => (l.source as SimNode).r + (l.target as SimNode).r + 72)
        .strength(0.35))
      .force('charge', forceManyBody().strength(-480))
      .force('collide', forceCollide<SimNode>().radius((d) => d.r + 20).iterations(2))
      .force('center', forceCenter(VB_W / 2, VB_H / 2 - 10))
      .alphaMin(0.02)
      .on('tick', () => setTick((t) => t + 1));
    simRef.current = sim;
    return () => { sim.stop(); simRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, relKey]);

  const neighbors = useMemo(() => {
    if (hover == null) return null;
    const s = new Set<number>([hover]);
    for (const l of linksRef.current) {
      const a = (l.source as SimNode).id;
      const b = (l.target as SimNode).id;
      if (a === hover) s.add(b);
      if (b === hover) s.add(a);
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, relKey]);

  const linkEnds = (l: SimLink): { s: SimNode; t: SimNode } | null => {
    const s = typeof l.source === 'object' ? l.source : nodesRef.current.find((n) => n.id === l.source);
    const t = typeof l.target === 'object' ? l.target : nodesRef.current.find((n) => n.id === l.target);
    return s && t ? { s, t } : null;
  };

  /** 从 from 圆心指向 to 圆心，返回从 from 圆盘边缘出发的坐标 */
  const discEdge = (from: SimNode, to: SimNode) => {
    const dx = (to.x ?? 0) - (from.x ?? 0);
    const dy = (to.y ?? 0) - (from.y ?? 0);
    const dist = Math.hypot(dx, dy) || 1;
    return { x: (from.x ?? 0) + (dx / dist) * (from.r + 5), y: (from.y ?? 0) + (dy / dist) * (from.r + 5) };
  };

  const toView = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (VB_W / rect.width), y: (e.clientY - rect.top) * (VB_H / rect.height) };
  };
  const startDrag = (e: React.PointerEvent, n: SimNode) => {
    e.preventDefault();
    const { x, y } = toView(e);
    drag.current = { id: n.id, dx: (n.x ?? 0) - x, dy: (n.y ?? 0) - y };
    simRef.current?.alphaTarget(0.25).restart();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const { x, y } = toView(e);
    const d = drag.current;
    const n = nodesRef.current.find((m) => m.id === d.id);
    if (!n) return;
    n.fx = clamp(x + d.dx, n.r + 18, VB_W - n.r - 18);
    n.fy = clamp(y + d.dy, n.r + 18, VB_H - n.r - 18);
  };
  const endDrag = () => {
    if (!drag.current) return;
    const n = nodesRef.current.find((m) => m.id === drag.current!.id);
    if (n) { n.fx = null; n.fy = null; }
    drag.current = null;
    simRef.current?.alphaTarget(0);
  };
  const relayout = () => {
    nodesRef.current.forEach((n) => {
      n.fx = null; n.fy = null;
      const ang = Math.random() * Math.PI * 2;
      const rad = 40 + Math.random() * 170;
      n.x = VB_W / 2 + Math.cos(ang) * rad;
      n.y = VB_H / 2 + Math.sin(ang) * rad;
    });
    simRef.current?.alpha(1).restart();
  };

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        style={{ width: '100%', display: 'block', userSelect: 'none', touchAction: 'none' }}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerLeave={() => { endDrag(); setHover(null); setHoverEdge(null); }}
      >
        <defs>
          <pattern id="rel-dots" width="26" height="26" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1.2" fill="var(--line)" />
          </pattern>
          <filter id="rel-shadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#43391f" floodOpacity="0.18" />
          </filter>
          <marker id="rel-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M0,0L10,5L0,10z" fill="var(--line-2)" />
          </marker>
          <marker id="rel-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M0,0L10,5L0,10z" fill="var(--accent)" />
          </marker>
        </defs>

        <rect width={VB_W} height={VB_H} rx={16} fill="var(--panel)" />
        <rect width={VB_W} height={VB_H} rx={16} fill="url(#rel-dots)" />
        <rect x={10} y={10} width={VB_W - 20} height={VB_H - 20} rx={12} fill="none" stroke="var(--line-2)" opacity={0.55} />

        {linksRef.current.map((l) => {
          const ends = linkEnds(l);
          if (!ends) return null;
          const { s, t } = ends;
          const on = hover === s.id || hover === t.id || hoverEdge === l.rel.id;
          const title = `${l.rel.from_name} ─【${l.rel.type}】→ ${l.rel.to_name}${l.rel.description ? `：${l.rel.description}` : ''}`;
          const labelW = Math.min(l.rel.type.length, 8) * 11 + 16;

          if (s.id === t.id) {
            const nx = s.x ?? 0;
            const ny = s.y ?? 0;
            const top = ny - s.r - 5;
            const d = `M ${nx} ${top} C ${nx - 55} ${top - 68}, ${nx + 55} ${top - 68}, ${nx} ${top}`;
            return (
              <g key={l.rel.id} opacity={hover == null && hoverEdge == null ? 0.9 : on ? 1 : 0.14}>
                <path d={d} fill="none" stroke="transparent" strokeWidth={16} style={{ cursor: 'pointer' }}
                  onPointerEnter={() => setHoverEdge(l.rel.id)} onPointerLeave={() => setHoverEdge(null)}>
                  <title>{title}</title>
                </path>
                <path d={d} fill="none" stroke={on ? 'var(--accent)' : 'var(--line-2)'} strokeWidth={on ? 2.2 : 1.6}
                  markerEnd={on ? 'url(#rel-arrow-on)' : 'url(#rel-arrow)'} />
                <g style={{ pointerEvents: 'none' }}>
                  <rect x={nx - labelW / 2} y={top - 62} width={labelW} height={20} rx={10}
                    fill="var(--panel)" stroke={on ? 'var(--accent)' : 'var(--line)'} />
                  <text x={nx} y={top - 52} textAnchor="middle" dy="0.35em" fontSize={11}
                    fill={on ? 'var(--accent)' : 'var(--ink-2)'} fontWeight={600}>
                    {l.rel.type.slice(0, 8)}
                  </text>
                </g>
              </g>
            );
          }

          const start = discEdge(s, t);
          const end = discEdge(t, s);
          const mx = (start.x + end.x) / 2;
          const my = (start.y + end.y) / 2;
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const dist = Math.hypot(dx, dy) || 1;
          const ctrl = { x: mx + (-dy / dist) * dist * 0.13 * l.bend, y: my + (dx / dist) * dist * 0.13 * l.bend };
          const lp = { x: (start.x + 2 * ctrl.x + end.x) / 4, y: (start.y + 2 * ctrl.y + end.y) / 4 };
          const d = `M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`;

          return (
            <g key={l.rel.id} opacity={hover == null && hoverEdge == null ? 0.9 : on ? 1 : 0.14}>
              <path d={d} fill="none" stroke="transparent" strokeWidth={18} style={{ cursor: 'pointer' }}
                onPointerEnter={() => setHoverEdge(l.rel.id)} onPointerLeave={() => setHoverEdge(null)}>
                <title>{title}</title>
              </path>
              <path d={d} fill="none" stroke={on ? 'var(--accent)' : 'var(--line-2)'} strokeWidth={on ? 2.2 : 1.6}
                strokeLinecap="round" markerEnd={on ? 'url(#rel-arrow-on)' : 'url(#rel-arrow)'} />
              <g style={{ pointerEvents: 'none' }}>
                <rect x={lp.x - labelW / 2} y={lp.y - 10} width={labelW} height={20} rx={10}
                  fill="var(--panel)" stroke={on ? 'var(--accent)' : 'var(--line)'} />
                <text x={lp.x} y={lp.y} textAnchor="middle" dy="0.35em" fontSize={11}
                  fill={on ? 'var(--accent)' : 'var(--ink-2)'} fontWeight={600}>
                  {l.rel.type.slice(0, 8)}
                </text>
              </g>
            </g>
          );
        })}

        {nodesRef.current.map((n) => {
          const color = ROLE_COLOR[n.role] || 'var(--muted)';
          const dim = neighbors != null && !neighbors.has(n.id);
          const on = hover === n.id || !!neighbors?.has(n.id);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              opacity={dim ? 0.18 : 1}
              style={{ cursor: 'grab', transition: 'opacity 0.2s' }}
              onPointerDown={(e) => startDrag(e, n)}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover(null)}
            >
              <title>{`${n.role} · ${n.name}`}</title>
              {on ? <circle r={n.r + 6} fill="none" stroke={color} strokeWidth={1.4} opacity={0.5} /> : null}
              <circle r={n.r} fill={ROLE_FILL[n.role] || 'var(--panel-2)'} stroke={color} strokeWidth={3} filter="url(#rel-shadow)" />
              <circle r={n.r - 7} fill="none" stroke={color} strokeWidth={1} strokeDasharray="2 4" opacity={0.55} />
              <text textAnchor="middle" dy="0.36em" fontSize={n.r * 0.72} fontFamily="var(--serif)" fontWeight={700} fill={color}>
                {n.name.charAt(0)}
              </text>
              <text
                textAnchor="middle" y={n.r + 20} fontSize={13} fontFamily="var(--serif)" fontWeight={600}
                fill="var(--ink)" stroke="var(--panel)" strokeWidth={3.5} paintOrder="stroke"
              >
                {n.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="row-wrap" style={{ gap: 8, justifyContent: 'center', marginTop: 10 }}>
        {ROLES.map((role) => (
          <span key={role} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
            color: ROLE_COLOR[role], background: ROLE_FILL[role], border: `1px solid ${ROLE_COLOR[role]}`,
          }}>
            {role}
          </span>
        ))}
        <button className="btn ghost small" onClick={relayout}>重排布局</button>
      </div>
      <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 6 }}>
        拖住节点可摆位 · 悬停节点或连线查看关系详情
      </p>
      {linksRef.current.length === 0 && (
        <p className="muted small" style={{ textAlign: 'center' }}>
          还没有连线 —— 点上方「＋ 新增关系」把人物连起来。
        </p>
      )}
    </div>
  );
}

export default function Characters() {
  const { project, reload } = useProject();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Character> | null>(null);
  const [relEditing, setRelEditing] = useState(false);
  const [rel, setRel] = useState<Partial<Relation>>({ type: '关系' });

  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/projects/${project.id}/characters/generate`);
      await reload();
      if (r.added === 0) setErr('AI 返回的角色都与现有角色重名，未新增。可先删除或改名后再试。');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setErr('角色名不能为空'); return; }
    try {
      if (editing.id) await api.put(`/projects/${project.id}/characters/${editing.id}`, editing);
      else await api.post(`/projects/${project.id}/characters`, editing);
      setEditing(null);
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const saveRel = async () => {
    if (!rel.from_name || !rel.to_name) { setErr('关系需要双方角色名'); return; }
    try {
      await api.post(`/projects/${project.id}/relations`, rel);
      setRelEditing(false);
      setRel({ type: '关系' });
      await reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <span className="muted small">「当前状态」会随章节写作自动同步 —— 它是 AI 写下一章时的人物记忆。</span>
        <span className="grow" />
        <button className="btn" onClick={() => { setRelEditing(true); setErr(null); }}>＋ 新增关系</button>
        <button className="btn" onClick={() => setEditing({ role: '配角' })}>＋ 手动新增角色</button>
        <button className="btn primary" disabled={busy} onClick={generate}>{busy ? <><Spinner /> AI 设计中…</> : 'AI 起草角色'}</button>
      </div>
      <ErrorNote error={err} />

      {project.characters.length === 0 && !busy ? (
        <Empty title="还没有人物" desc="让 AI 设计主角、重要配角与反派：每个人都有核心欲望、致命缺陷与主线的绑定方式，反派逻辑自洽。" />
      ) : (
        <div className="grid grid-2">
          {project.characters.map((c) => (
            <div key={c.id} className="card" style={{ padding: '16px 18px' }}>
              <div className="row">
                <span style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{c.name}</span>
                <Badge tone={ROLE_TONE[c.role] || 'default'}>{c.role}</Badge>
                <span className="grow" />
                <button className="btn ghost small" onClick={() => setEditing(c)}>编辑</button>
                <ConfirmButton
                  className="btn ghost small"
                  onConfirm={async () => { await api.del(`/projects/${project.id}/characters/${c.id}`); await reload(); }}
                >
                  删除
                </ConfirmButton>
              </div>
              <p className="muted mt8" style={{ lineHeight: 1.8, fontSize: 13 }}>{c.profile}</p>
              <div className="kv mt8">
                {c.goals ? <div><b>目标</b>{c.goals}</div> : null}
                {c.appearance ? <div><b>外貌</b>{c.appearance}</div> : null}
              </div>
              {c.status ? (
                <div className="mt8" style={{ background: 'var(--warn-soft)', border: '1px solid #e8d9b0', color: 'var(--warn)', borderRadius: 7, padding: '7px 10px', fontSize: 12.5, lineHeight: 1.7 }}>
                  当前状态 · {c.status}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {(project.characters.length > 0 || project.relations.length > 0) && (
        <div className="card mt16">
          <div className="card-title">关系图</div>
          <RelGraph characters={project.characters} relations={project.relations} />
          {project.relations.length > 0 && (
            <div style={{ marginTop: 10, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
              {project.relations.map((r) => (
                <div key={r.id} className="rel-row">
                  <b>{r.from_name}</b>
                  <span className="rel-arrow">─【{r.type}】→</span>
                  <b>{r.to_name}</b>
                  <span className="muted grow">{r.description}</span>
                  <ConfirmButton
                    className="btn ghost small"
                    onConfirm={async () => { await api.del(`/projects/${project.id}/relations/${r.id}`); await reload(); }}
                  >
                    删除
                  </ConfirmButton>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? `编辑角色 · ${editing.name}` : '新增角色'} onClose={() => setEditing(null)}>
          <div className="grid grid-2">
            <Field label="姓名"><input type="text" value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="定位">
              <select value={editing.role || '配角'} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                {ROLES.map((r) => <option key={r}>{r}</option>)}
              </select>
            </Field>
          </div>
          <Field label="性格与背景"><textarea rows={3} value={editing.profile || ''} onChange={(e) => setEditing({ ...editing, profile: e.target.value })} /></Field>
          <Field label="核心目标与动机"><textarea rows={2} value={editing.goals || ''} onChange={(e) => setEditing({ ...editing, goals: e.target.value })} /></Field>
          <Field label="外貌特征"><input type="text" value={editing.appearance || ''} onChange={(e) => setEditing({ ...editing, appearance: e.target.value })} /></Field>
          <Field label="当前状态" hint="写作同步的目标字段，也可手填">
            <input type="text" value={editing.status || ''} onChange={(e) => setEditing({ ...editing, status: e.target.value })} />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary" onClick={save}>保存</button>
          </div>
        </Modal>
      )}

      {relEditing && (
        <Modal title="新增关系" onClose={() => setRelEditing(false)}>
          <div className="grid grid-2">
            <Field label="角色 A">
              <select value={rel.from_name || ''} onChange={(e) => setRel({ ...rel, from_name: e.target.value })}>
                <option value="">选择…</option>
                {project.characters.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="角色 B">
              <select value={rel.to_name || ''} onChange={(e) => setRel({ ...rel, to_name: e.target.value })}>
                <option value="">选择…</option>
                {project.characters.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="关系类型"><input type="text" value={rel.type || ''} onChange={(e) => setRel({ ...rel, type: e.target.value })} placeholder="例：相互亏欠的盟友 / 立场对立" /></Field>
          <Field label="一句话说明"><input type="text" value={rel.description || ''} onChange={(e) => setRel({ ...rel, description: e.target.value })} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setRelEditing(false)}>取消</button>
            <button className="btn primary" onClick={saveRel}>保存</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
