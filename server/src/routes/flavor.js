/**
 * 去AI味路由：配置读写、章节扫描（含留档/趋势）、按命中项改写、按问题清单整章补丁修复。
 * 扫描只读正文，不改作品；补丁修复返回预览文本，由作者确认后才替换并保存。
 */
import { Router } from 'express';
import { get } from '../db.js';
import { callAI } from '../ai.js';
import * as P from '../prompts.js';
import * as M from '../mock.js';
import { sseFrame, parseJSONLoose } from '../util.js';
import {
  DEFAULT_FLAVOR_SETTINGS,
  SEMANTIC_RULES,
  getFlavorConfig,
  saveFlavorConfig,
  buildDefaultRules,
  scanFlavor,
  recordFlavorScan,
  flavorHistory,
  flavorTrend,
  buildAvoidList,
  clearAvoidList,
  buildLexiconText,
  scanWordHits,
} from '../flavor.js';

const r = Router();

const proj = (id) => get('SELECT * FROM projects WHERE id = ?', Number(id));
const chapter = (pid, cid) => get('SELECT * FROM chapters WHERE id = ? AND project_id = ?', Number(cid), Number(pid));

/* ============ 配置 ============ */

r.get('/flavor/settings', (req, res) => {
  const cfg = getFlavorConfig();
  res.json({
    ...cfg,
    defaults: { ...DEFAULT_FLAVOR_SETTINGS, rules: buildDefaultRules() },
    semanticRules: SEMANTIC_RULES,
  });
});

r.put('/flavor/settings', (req, res) => {
  res.json(saveFlavorConfig(req.body || {}));
});

r.post('/flavor/rules/reset', (req, res) => {
  const cfg = getFlavorConfig();
  res.json(saveFlavorConfig({ ...cfg, rules: buildDefaultRules() }));
});

/* ============ 扫描 ============ */

r.post('/projects/:id/chapters/:cid/flavor-scan', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : c.content;
  if (!String(text || '').trim()) return res.status(400).json({ error: '本章还没有正文，先写点内容再扫描' });

  try {
    const cfg = getFlavorConfig();
    const report = await scanFlavor(text, { config: cfg, projectId: p.id, chapterId: c.id });
    if (body.record !== false) {
      try {
        recordFlavorScan({
          projectId: p.id,
          chapterId: c.id,
          chapterIdx: c.idx,
          text,
          report,
        });
      } catch { /* 留档失败不影响本次扫描结果 */ }
    }
    let trend = null;
    let avoidTop = [];
    try {
      trend = flavorTrend(p.id, 12);
      avoidTop = buildAvoidList(p.id, cfg.avoidMinHits, 12);
    } catch { /* 趋势 / 避雷库读取失败不影响扫描 */ }
    res.json({
      ...report,
      chapterId: c.id,
      text,
      trend,
      avoidTop,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || '扫描失败' });
  }
});

/* ============ 历史趋势 / 避雷库 ============ */

r.get('/projects/:id/flavor-history', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const limit = Number(req.query.limit) || 12;
  res.json({ rows: flavorHistory(p.id, limit), trend: flavorTrend(p.id, limit) });
});

r.get('/projects/:id/flavor-avoid', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const cfg = getFlavorConfig();
  res.json({
    terms: buildAvoidList(p.id, cfg.avoidMinHits, 30),
    minHits: cfg.avoidMinHits,
    limit: cfg.avoidLimit,
    enabled: cfg.avoidEnabled,
  });
});

r.post('/projects/:id/flavor-avoid/reset', (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  res.json({ removed: clearAvoidList(p.id), terms: [] });
});

/* ============ 按命中项改写（SSE） ============ */

/** 去掉模型偶然带出的「改写后的片段：」等元信息，避免写回正文时反复出现前缀 */
function cleanRewriteText(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^【(?:改写|润色|修改|演示|结果|输出)[^】]*】[^\n]*\n+/, '').trim();
  text = text.replace(/^(?:改写|润色|修改|结果|输出)[^\n]{0,20}[:：]\s*\n?/, '').trim();
  return text;
}

r.post('/projects/:id/chapters/:cid/flavor-rewrite', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const { selection = '', hits = [], before = '', after = '' } = req.body || {};
  if (!String(selection).trim()) return res.status(400).json({ error: '缺少要改写的片段' });
  const cfg = getFlavorConfig();
  const avoid = buildAvoidList(p.id, cfg.avoidMinHits, cfg.avoidLimit);
  const { lexiconText, avoidText } = buildLexiconText(cfg, avoid);
  const { system, user } = P.flavorRewrite(selection, hits, before, after, lexiconText, avoidText);
  const beforeHits = cfg.wordEnabled ? scanWordHits(String(selection), cfg.rules) : [];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) { closed = true; ac.abort(); } });
  const send = (event, data) => { if (!closed) res.write(sseFrame(event, data)); };

  send('start', { chapterId: c.id, mode: 'flavor-rewrite' });
  try {
    const out = await callAI({
      task: 'writer', step: 'flavor_rewrite', system, user,
      projectId: p.id, chapterId: c.id, stream: true, signal: ac.signal,
      onDelta: (d) => send('delta', { text: d }),
      mock: () => M.rewriteText(selection, '去掉AI腔，保持原意'),
    });
    const cleaned = cleanRewriteText(out.text) || String(out.text || '').trim();
    if (!cleaned) throw new Error('改写模型没有返回正文');
    const afterHits = cfg.wordEnabled ? scanWordHits(cleaned, cfg.rules) : [];
    const beforeKeys = new Set(beforeHits.map((h) => h.rulePhrase || h.phrase));
    const newHits = [...new Set(
      afterHits.filter((h) => !beforeKeys.has(h.rulePhrase || h.phrase)).map((h) => h.phrase)
    )].slice(0, 6);
    send('done', {
      text: cleaned,
      usage: out.usage,
      model: out.model,
      flavor: { before: beforeHits.length, after: afterHits.length, newHits },
    });
  } catch (e) {
    send('error', { message: e?.message || '改写失败' });
  }
  res.end();
});

/* ============ 按问题清单整章补丁修复 ============ */

const SEVERITY_SET = new Set(['low', 'medium', 'high']);

function digitsOf(s) {
  return (String(s).match(/\d+(?:\.\d+)?/g) || []).sort().join(',');
}

/** 校验模型补丁：逐字命中、唯一、不重叠、不改数字、不引入新 AI 腔；从后往前应用 */
function applyPatches(text, rawPatches, issues, cfg) {
  const allowed = new Map((issues || []).map((it) => [it.issueId, it]));
  const taken = new Set();
  const skipped = [];
  const candidates = [];

  for (const raw of (Array.isArray(rawPatches) ? rawPatches : []).slice(0, 8)) {
    const issueId = String(raw?.issueId || '');
    if (!allowed.has(issueId) || taken.has(issueId)) {
      skipped.push({ issueId, reason: '问题编号无效或重复' });
      continue;
    }
    const target = String(raw?.targetExcerpt || '').trim();
    const replacement = String(raw?.replacement || '').trim();
    if (target.length < 6) {
      skipped.push({ issueId, reason: '原文片段过短' });
      continue;
    }
    if (!replacement || replacement === target) {
      skipped.push({ issueId, reason: '没有实际改动' });
      continue;
    }
    if (replacement.length > target.length * 3 + 120) {
      skipped.push({ issueId, reason: '改写扩写过度' });
      continue;
    }
    const first = text.indexOf(target);
    if (first < 0 || text.indexOf(target, first + target.length) >= 0) {
      skipped.push({ issueId, reason: '原文片段不存在或不唯一' });
      continue;
    }
    if (digitsOf(target) !== digitsOf(replacement)) {
      skipped.push({ issueId, reason: '补丁改动了数字/时间' });
      continue;
    }
    if (cfg?.wordEnabled) {
      const beforeHits = scanWordHits(target, cfg.rules);
      const afterHits = scanWordHits(replacement, cfg.rules);
      const beforeKeys = new Set(beforeHits.map((h) => h.rulePhrase || h.phrase));
      const introduced = [...new Set(
        afterHits.filter((h) => !beforeKeys.has(h.rulePhrase || h.phrase)).map((h) => h.phrase)
      )];
      /* 替换后没有减少命中，却换入新的模板词，视为“越改越 AI”，直接跳过 */
      if (introduced.length && afterHits.length >= beforeHits.length) {
        skipped.push({ issueId, reason: `替换文本引入新的 AI 腔：${introduced.slice(0, 3).join('、')}` });
        continue;
      }
    }
    taken.add(issueId);
    candidates.push({
      issueId,
      ruleName: allowed.get(issueId)?.ruleName || '',
      start: first,
      end: first + target.length,
      before: target,
      after: replacement,
      reason: String(raw?.reason || '').slice(0, 200),
    });
  }

  candidates.sort((a, b) => a.start - b.start);
  const accepted = [];
  let lastEnd = -1;
  for (const item of candidates) {
    if (item.start < lastEnd) {
      skipped.push({ issueId: item.issueId, reason: '补丁区间重叠' });
      continue;
    }
    accepted.push(item);
    lastEnd = item.end;
  }

  let next = text;
  for (let i = accepted.length - 1; i >= 0; i--) {
    const item = accepted[i];
    next = next.slice(0, item.start) + item.after + next.slice(item.end);
  }
  return { text: next, applied: accepted, skipped };
}

r.post('/projects/:id/chapters/:cid/flavor-repair', async (req, res) => {
  const p = proj(req.params.id);
  if (!p) return res.status(404).json({ error: '作品不存在' });
  const c = chapter(p.id, req.params.cid);
  if (!c) return res.status(404).json({ error: '章节不存在' });

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : c.content;
  if (!String(text || '').trim()) return res.status(400).json({ error: '本章还没有正文' });

  /* 入参只当问题提示：逐条核对证据是否仍在当前正文中，避免正文被改动后误修 */
  const valid = [];
  for (const raw of (Array.isArray(body.issues) ? body.issues : []).slice(0, 8)) {
    const excerpt = String(raw?.excerpt || '').trim();
    if (excerpt.length < 6) continue;
    if (!String(text).includes(excerpt)) continue;
    valid.push({
      issueId: String(raw.issueId || raw.id || `issue_${valid.length + 1}`),
      ruleName: String(raw.ruleName || '反AI规则').slice(0, 60),
      excerpt,
      reason: String(raw.reason || '').slice(0, 300),
      suggestion: String(raw.suggestion || '').slice(0, 300),
      severity: SEVERITY_SET.has(raw.severity) ? raw.severity : 'medium',
    });
  }
  if (!valid.length) {
    return res.status(400).json({ error: '问题证据已失效（正文可能已改动），请重新扫描后再修复' });
  }

  try {
    const cfg = getFlavorConfig();
    const avoid = buildAvoidList(p.id, cfg.avoidMinHits, cfg.avoidLimit);
    const { lexiconText, avoidText } = buildLexiconText(cfg, avoid);
    const { system, user } = P.flavorRepair(text, valid, lexiconText, avoidText);
    const out = await callAI({
      task: 'writer', step: 'flavor_repair', system, user,
      projectId: p.id, chapterId: c.id,
      temperature: 0.35,
      mock: () => M.flavorRepairJson(text, valid),
    });
    const parsed = parseJSONLoose(out.text);
    if (!parsed || !Array.isArray(parsed.patches)) {
      return res.status(502).json({ error: '模型没有返回可用的补丁结构，请重试' });
    }
    const result = applyPatches(String(text), parsed.patches, valid, cfg);
    /* 修复后自动跑一遍机械层，给作者看到分数是否真的降了，而不是再手动复扫才知道 */
    const mechCfg = { ...cfg, modelEnabled: false };
    const beforeReport = await scanFlavor(String(text), { config: mechCfg, projectId: p.id });
    const afterReport = await scanFlavor(result.text, { config: mechCfg, projectId: p.id });
    res.json({
      text: result.text,
      summary: String(parsed.summary || '').slice(0, 300),
      applied: result.applied.length,
      skipped: result.skipped,
      patches: result.applied,
      scoreBefore: beforeReport.score,
      scoreAfter: afterReport.score,
      wordBefore: beforeReport.wordHits.length,
      wordAfter: afterReport.wordHits.length,
      statBefore: beforeReport.statHits.length,
      statAfter: afterReport.statHits.length,
      blockThreshold: cfg.blockThreshold,
      remaining: afterReport.wordHits.slice(0, 10).map((h) => ({
        phrase: h.phrase,
        severity: h.severity,
        suggestion: h.suggestion,
        inDialogue: !!h.inDialogue,
      })),
      model: out.model,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || '修复失败' });
  }
});

export default r;
