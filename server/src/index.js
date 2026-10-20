import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PORT, HOST } from './env.js';
import { isMockMode, getAISettings } from './ai.js';
import writingRouter from './routes/writing.js';
import projectsRouter from './routes/projects.js';
import batchRouter from './routes/batch.js';
import systemRouter from './routes/system.js';
import demoRouter from './routes/demo.js';
import flavorRouter from './routes/flavor.js';
import deconstructRouter from './routes/deconstruct.js';
import templatesRouter from './routes/templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

/* 本地开发直连时的基础 CORS */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'NovelWriter', version: '0.2.0', mock: isMockMode() });
});

app.use('/api/projects', batchRouter);
app.use('/api/projects', writingRouter);
app.use('/api/projects', deconstructRouter);
app.use('/api/projects', templatesRouter);
app.use('/api/projects', projectsRouter);
app.use('/api', demoRouter);
app.use('/api', systemRouter);
app.use('/api', flavorRouter);

/* 生产模式：托管前端构建产物（client/dist） */
const dist = path.resolve(__dirname, '../../client/dist');
const indexHtml = path.join(dist, 'index.html');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(indexHtml);
    } else next();
  });
}

app.use((req, res) => res.status(404).json({ error: `接口不存在：${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server error]', err);
  if (res.headersSent) return next(err);
  res.status(err?.status || 500).json({ error: err?.message || '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  const s = getAISettings();
  console.log(`[NovelWriter] 服务已启动: http://${HOST}:${PORT}`);
  console.log(`[NovelWriter] AI 模式: ${isMockMode() ? 'Mock 演示模式（未配置模型，功能可完整体验）' : s.baseUrl + ' · ' + (s.models.planner || s.models.writer || s.models.reviewer)}`);
});
