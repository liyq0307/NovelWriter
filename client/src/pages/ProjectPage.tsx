import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, STATUS_NAMES } from '../api';
import { Badge, Spinner, ErrorNote, ConfirmButton } from '../components/ui';
import type { Project } from '../types';
import Overview from './Overview';
import Directions from './Directions';
import Plan from './Plan';
import World from './World';
import Characters from './Characters';
import Writer from './Writer';
import Rules from './Rules';
import Usage from './Usage';

interface Ctx {
  project: Project;
  reload: () => Promise<void>;
}
const ProjectCtx = createContext<Ctx | null>(null);
export function useProject(): Ctx {
  const v = useContext(ProjectCtx);
  if (!v) throw new Error('useProject 必须在 ProjectPage 内使用');
  return v;
}

const NAV = [
  { to: '', label: '概览', num: '一', end: true },
  { to: 'direction', label: '方向', num: '二' },
  { to: 'world', label: '世界手册', num: '三' },
  { to: 'characters', label: '角色库', num: '四' },
  { to: 'plan', label: '架构规划', num: '五' },
  { to: 'write', label: '写作台', num: '六' },
  { to: 'rules', label: '写法规则', num: '七' },
  { to: 'usage', label: 'AI 用量', num: '八' },
];

export default function ProjectPage() {
  const { id } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const reload = useCallback(async () => {
    try {
      setProject(await api.get(`/projects/${id}`));
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  if (err) {
    return (
      <main className="page">
        <ErrorNote error={err} onRetry={reload} />
      </main>
    );
  }
  if (!project) return <div className="loading-block"><Spinner text="正在打开这本书…" /></div>;

  return (
    <ProjectCtx.Provider value={{ project, reload }}>
      <div className="project-shell">
        <nav className="project-nav">
          <div className="nav-group">
            <div className="nav-label">创作管线</div>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to === '' ? `/p/${project.id}` : `/p/${project.id}/${n.to}`} end={n.end as boolean}>
                <span className="nav-num">{n.num}</span>
                {n.label}
              </NavLink>
            ))}
          </div>
          <div className="nav-group">
            <div className="nav-label">本书</div>
            <ConfirmButton
              className="btn ghost small"
              onConfirm={async () => {
                await api.del(`/projects/${project.id}`);
                nav('/');
              }}
            >
              删除本书
            </ConfirmButton>
          </div>
        </nav>
        <main className="project-main">
          <div className="project-head">
            <h1>{project.title}</h1>
            <Badge tone={project.type === 'short' ? 'info' : 'default'}>{project.type === 'short' ? '短篇' : '长篇'}</Badge>
            <Badge tone="accent">{STATUS_NAMES[project.status] || project.status}</Badge>
            <span className="muted small">{project.word_total} 字 · {project.chapters.filter((c) => c.word_count > 0).length}/{project.chapters.length} 章</span>
            <span className="grow" />
            <label className="row small muted" style={{ cursor: 'pointer' }} title="每章保存后自动提取角色处境变化，写入角色库">
              <input
                type="checkbox"
                checked={!!project.sync_state}
                onChange={async (e) => { await api.patch(`/projects/${project.id}`, { sync_state: e.target.checked }); reload(); }}
              />
              写后同步角色状态
            </label>
            <a className="btn small" href={`/api/projects/${project.id}/export?format=md`}>导出 MD</a>
            <a className="btn small" href={`/api/projects/${project.id}/export?format=txt`}>TXT</a>
          </div>
          <Routes>
            <Route index element={<Overview />} />
            <Route path="direction" element={<Directions />} />
            <Route path="plan" element={<Plan />} />
            <Route path="world" element={<World />} />
            <Route path="characters" element={<Characters />} />
            <Route path="write" element={<Writer />} />
            <Route path="write/:chapterId" element={<Writer />} />
            <Route path="rules" element={<Rules />} />
            <Route path="usage" element={<Usage />} />
          </Routes>
        </main>
      </div>
    </ProjectCtx.Provider>
  );
}
