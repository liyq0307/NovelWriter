/** 批量连写路由：创建、查看、暂停、继续、取消、接入进度流 */
import { Router } from 'express';
import { all } from '../db.js';
import {
  createBatch, batchSummary, pauseBatch, resumeBatch, cancelBatch, attachBatch,
} from '../batch.js';

const r = Router();

const fail = (res, e) => res.status(e?.status || 500).json({ error: e?.message || '连写任务失败', batch: e?.batch });

r.get('/:id/batches', (req, res) => {
  const rows = all('SELECT * FROM batches WHERE project_id = ? ORDER BY id DESC LIMIT 20', Number(req.params.id));
  res.json(rows.map((b) => batchSummary(b.id)));
});

r.post('/:id/batches', (req, res) => {
  try {
    res.json(createBatch(req.params.id, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/:id/batches/:bid', (req, res) => {
  const b = batchSummary(req.params.bid);
  if (!b || b.project_id !== Number(req.params.id)) return res.status(404).json({ error: '连写任务不存在' });
  res.json(b);
});

r.post('/:id/batches/:bid/attach', (req, res) => attachBatch(req, res, req.params.bid));

r.post('/:id/batches/:bid/pause', (req, res) => {
  try { res.json(pauseBatch(req.params.bid)); } catch (e) { fail(res, e); }
});

r.post('/:id/batches/:bid/resume', (req, res) => {
  try { res.json(resumeBatch(req.params.bid)); } catch (e) { fail(res, e); }
});

r.post('/:id/batches/:bid/cancel', (req, res) => {
  try { res.json(cancelBatch(req.params.bid)); } catch (e) { fail(res, e); }
});

export default r;
