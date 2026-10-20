/**
 * 示例作品路由：一键载入一本可直接体验的完整示例书。
 */
import { Router } from 'express';
import { seedDemo } from '../demo.js';

const r = Router();

r.post('/demo', (req, res) => {
  try {
    const result = seedDemo();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || '示例作品创建失败' });
  }
});

export default r;
