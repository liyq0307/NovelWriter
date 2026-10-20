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
import Threads from './Threads';
import Rules from './Rules';
import Usage from './Usage';
import Flavor from './Flavor';
import Prompts from './Prompts';
import Deconstruct from './Deconstruct';

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

const NAV_GROUPS = [
  {
    label: '创作管线',
    items: [
      { to: 'direction', label: '方向' },
      { to: 'world', label: '世界手册' },
      { to: 'characters', label: '角色库' },
      { to: 'plan', label: '架构规划' },
      { to: 'write', label: '写作台' },
      { to: 'threads', label: '伏笔线索' },
    ],
  },
  {
    label: '写作规范',
    items: [
      { to: 'rules', label: '写法规则' },
      { to: 'flavor', label: '去AI味' },
    ],
  },
  {
    label: '参考与学习',
    items: [
      { to: 'deconstruct', label: '拆书' },
    ],
  },
  {
    label: '系统',
    items: [
      { to: 'prompts', label: '提示词模板' },
      { to: 'usage', label: 'AI 用量' },
    ],
  },
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
            <NavLink to={`/p/${project.id}`} end>概览</NavLink>
          </div>
          {NAV_GROUPS.map((g) => (
            <div key={g.label} className="nav-group">
              <div className="nav-label">{g.label}</div>
              {g.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to === '' ? `/p/${project.id}` : `/p/${project.id}/${n.to}`}
                >
                  {n.label}
                </NavLink>
              ))}
            </div>
          ))}
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
            <details className="dropdown">
              <summary className="btn small">导出</summary>
              <div
                className="dropdown-menu"
                onClick={(e) => {
                  const d = e.currentTarget.parentElement as HTMLDetailsElement | null;
                  if (d) d.open = false;
                }}
              >
                <a href={`/api/projects/${project.id}/export?format=md`}>Markdown（.md）</a>
                <a href={`/api/projects/${project.id}/export?format=txt`}>纯文本（.txt）</a>
                <a href={`/api/projects/${project.id}/export?format=docx`}>Word（.docx）</a>
                <a href={`/api/projects/${project.id}/export?format=epub`}>EPUB（.epub）</a>
              </div>
            </details>
          </div>
          <Routes>
            <Route index element={<Overview />} />
            <Route path="direction" element={<Directions />} />
            <Route path="plan" element={<Plan />} />
            <Route path="world" element={<World />} />
            <Route path="characters" element={<Characters />} />
            <Route path="write" element={<Writer />} />
            <Route path="write/:chapterId" element={<Writer />} />
            <Route path="threads" element={<Threads />} />
            <Route path="rules" element={<Rules />} />
            <Route path="flavor" element={<Flavor />} />
            <Route path="usage" element={<Usage />} />
            <Route path="prompts" element={<Prompts />} />
            <Route path="deconstruct" element={<Deconstruct />} />
          </Routes>
        </main>
      </div>
    </ProjectCtx.Provider>
  );
}
