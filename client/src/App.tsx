import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from './api';
import Bookshelf from './pages/Bookshelf';
import Settings from './pages/Settings';
import ProjectPage from './pages/ProjectPage';

function TopBar() {
  const [mock, setMock] = useState<boolean | null>(null);
  const loc = useLocation();
  useEffect(() => {
    api.get('/health').then((h) => setMock(!!h.mock)).catch(() => setMock(null));
  }, [loc.pathname]);
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <span>NovelWriter<span className="brand-dot">·</span></span>
        <span className="brand-sub">小说创作平台</span>
      </Link>
      <nav className="topnav">
        <Link to="/" className={loc.pathname === '/' ? 'active' : ''}>书架</Link>
        <Link to="/settings" className={loc.pathname.startsWith('/settings') ? 'active' : ''}>设置</Link>
      </nav>
      <span className="grow" />
      {mock === true && <span className="mock-badge" title="未配置真实模型，使用内置演示引擎，可完整体验流程">MOCK 演示模式</span>}
    </header>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <TopBar />
      <Routes>
        <Route path="/" element={<Bookshelf />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/p/:id/*" element={<ProjectPage />} />
        <Route path="*" element={<Bookshelf />} />
      </Routes>
    </BrowserRouter>
  );
}
