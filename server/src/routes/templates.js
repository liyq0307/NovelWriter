/** 提示词模板路由：查看内置步骤、保存本书覆盖、历史与回滚 */
import { Router } from 'express';
import { get } from '../db.js';
import {
  listTemplates, saveTemplate, resetTemplate, templateHistory, rollbackTemplate,
} from '../templates.js';

const r = Router();

const proj = (id) => get('SELECT * FROM projects WHERE id = ?', Number(id));

r.get('/:id/prompt-templates', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  res.json(listTemplates(p.id));
});

r.put('/:id/prompt-templates/:step', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  try {
    const row = saveTemplate(p.id, req.params.step, {
      system: req.body?.system || '',
      suffix: req.body?.suffix || '',
    });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

r.delete('/:id/prompt-templates/:step', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  res.json(resetTemplate(p.id, req.params.step));
});

r.get('/:id/prompt-templates/:step/history', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  res.json(templateHistory(p.id, req.params.step));
});

r.post('/:id/prompt-templates/:step/rollback', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  try {
    const row = rollbackTemplate(p.id, req.params.step, req.body?.historyId);
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default r;
