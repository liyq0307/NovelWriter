/**
 * 批量连写（自动导演简版）：在授权范围内逐章生成 → 保存 → 写后整理 → 检查。
 * - 任务落库，可暂停、恢复、取消；服务重启后仍可从保存进度继续
 * - SSE attach 只负责推送进度，断开页面不会中断任务
 */
import { all, get, run, now, parseField } from './db.js';
import { callAI } from './ai.js';
import * as P from './prompts.js';
import * as M from './mock.js';
import { sseFrame, countWords } from './util.js';
import {
  chapterContext, chapterTarget, mockCtx, saveChapterContent, reviewChapter,
} from './pipeline.js';

/** batchId -> 运行时状态 */
const jobs = new Map();

/* 服务重启后没有运行时：把上次未结束的任务标记为暂停，等待用户继续 */
run(
  "UPDATE batches SET status = 'paused', message = '服务已重启，任务已暂停；可继续执行', updated_at = ? WHERE status = 'running'",
  now()
);

function rtFor(id) {
  const key = Number(id);
  let rt = jobs.get(key);
  if (!rt) {
    rt = { paused: false, cancelled: false, running: false, subs: new Set(), log: [], abort: null };
    jobs.set(key, rt);
  }
  return rt;
}

const batchRow = (id) => get('SELECT * FROM batches WHERE id = ?', Number(id));

export function batchSummary(id) {
  const b = batchRow(id);
  if (!b) return null;
  const rt = jobs.get(Number(id));
  return { ...b, running: !!rt?.running, paused: !!rt?.paused };
}

function updateBatch(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return batchRow(id);
  run(`UPDATE batches SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...keys.map((k) => fields[k]), Number(id));
  return batchRow(id);
}

function emit(rt, event, data) {
  const frame = sseFrame(event, data);
  if (rt.log.length < 300) rt.log.push({ event, data });
  for (const res of rt.subs) {
    try { res.write(frame); } catch { rt.subs.delete(res); }
  }
}

/** 页面接入进度流 */
export function attachBatch(req, res, id) {
  const b = batchRow(id);
  if (!b) return res.status(404).json({ error: '连写任务不存在' });
  const rt = rtFor(b.id);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(sseFrame('batch', batchSummary(b.id)));
  for (const item of rt.log.slice(-120)) res.write(sseFrame(item.event, item.data));

  if (!rt.running) {
    res.write(sseFrame('done', { batch: batchSummary(b.id) }));
    return res.end();
  }

  rt.subs.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }, 15_000);
  res.on('close', () => { clearInterval(hb); rt.subs.delete(res); });
}

/** 创建并启动一次连写 */
export function createBatch(projectId, opts = {}) {
  const p = get('SELECT * FROM projects WHERE id = ?', Number(projectId));
  if (!p) throw Object.assign(new Error('作品不存在'), { status: 404 });
  const chapters = all('SELECT idx FROM chapters WHERE project_id = ? ORDER BY idx', p.id);
  if (!chapters.length) throw Object.assign(new Error('还没有章节，请先完成拆章'), { status: 400 });

  const minIdx = chapters[0].idx;
  const maxIdx = chapters[chapters.length - 1].idx;
  const from = Math.max(minIdx, Number(opts.fromIdx) || minIdx);
  const to = Math.min(maxIdx, Number(opts.toIdx) || maxIdx);
  if (to < from) throw Object.assign(new Error('章节范围不正确'), { status: 400 });

  const active = get("SELECT * FROM batches WHERE project_id = ? AND status IN ('running','paused') ORDER BY id DESC LIMIT 1", p.id);
  if (active) throw Object.assign(new Error('本书已有进行中的连写任务，请先继续或取消它'), { status: 409, batch: batchSummary(active.id) });

  const t = now();
  const info = run(`INSERT INTO batches (project_id, status, from_idx, to_idx, cursor_idx, done_chapters, words_added, review, sync, overwrite, message, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    p.id, 'running', from, to, from - 1, 0, 0,
    opts.review === false ? 0 : 1,
    opts.sync === false ? 0 : 1,
    opts.overwrite ? 1 : 0,
    '', t, t);
  const id = Number(info.lastInsertRowid);
  setImmediate(() => runBatch(id));
  return batchSummary(id);
}

export function pauseBatch(id) {
  const b = batchRow(id);
  if (!b) throw Object.assign(new Error('连写任务不存在'), { status: 404 });
  const rt = rtFor(id);
  rt.paused = true;
  if (!rt.running) updateBatch(id, { status: 'paused', message: '已暂停，可随时继续', updated_at: now() });
  return batchSummary(id);
}

export function resumeBatch(id) {
  const b = batchRow(id);
  if (!b) throw Object.assign(new Error('连写任务不存在'), { status: 404 });
  if (b.status === 'done') throw Object.assign(new Error('任务已完成'), { status: 400 });
  const rt = rtFor(id);
  rt.paused = false;
  rt.cancelled = false;
  if (!rt.running) {
    updateBatch(id, { status: 'running', message: '', updated_at: now() });
    setImmediate(() => runBatch(id));
  }
  return batchSummary(id);
}

export function cancelBatch(id) {
  const b = batchRow(id);
  if (!b) throw Object.assign(new Error('连写任务不存在'), { status: 404 });
  const rt = rtFor(id);
  rt.cancelled = true;
  try { rt.abort?.abort(); } catch { /* 忽略 */ }
  if (!rt.running) updateBatch(id, { status: 'cancelled', message: '已取消', updated_at: now() });
  return batchSummary(id);
}

/** 服务重启后没有运行时：恢复一个已存在的任务 */
export function hasRuntime(id) {
  return !!jobs.get(Number(id));
}

/** 主循环 */
async function runBatch(id) {
  const rt = rtFor(id);
  if (rt.running) return;
  rt.running = true;

  let b = batchRow(id);
  if (!b) { rt.running = false; return; }
  const pid = b.project_id;
  updateBatch(id, { status: 'running', message: '', updated_at: now() });
  emit(rt, 'batch', batchSummary(id));

  try {
    for (;;) {
      b = batchRow(id);
      if (!b) break;
      const p = get('SELECT * FROM projects WHERE id = ?', pid);
      if (!p) throw new Error('作品已被删除');

      if (rt.cancelled) {
        updateBatch(id, { status: 'cancelled', message: '已取消', updated_at: now() });
        emit(rt, 'batch', batchSummary(id));
        break;
      }
      if (rt.paused) {
        updateBatch(id, { status: 'paused', message: '已暂停，可随时继续', updated_at: now() });
        emit(rt, 'batch', batchSummary(id));
        break;
      }
      if (b.cursor_idx >= b.to_idx) {
        updateBatch(id, { status: 'done', message: `已完成第 ${b.from_idx}—${b.to_idx} 章`, updated_at: now() });
        emit(rt, 'batch', batchSummary(id));
        emit(rt, 'done', { batch: batchSummary(id) });
        break;
      }

      const next = get(
        `SELECT * FROM chapters WHERE project_id = ? AND idx > ? AND idx <= ? ORDER BY idx LIMIT 1`,
        pid, b.cursor_idx, b.to_idx
      );
      if (!next) {
        updateBatch(id, { status: 'done', message: '范围内已无待处理章节', updated_at: now() });
        emit(rt, 'batch', batchSummary(id));
        emit(rt, 'done', { batch: batchSummary(id) });
        break;
      }

      const ch = { ...next, cast: parseField(next.cast_names, []), review: parseField(next.review, null) };
      if (ch.word_count > 0 && !b.overwrite) {
        updateBatch(id, { cursor_idx: ch.idx, message: `第 ${ch.idx} 章已有正文，已跳过`, updated_at: now() });
        emit(rt, 'skip', { chapterId: ch.id, idx: ch.idx, title: ch.title });
        emit(rt, 'batch', batchSummary(id));
        continue;
      }

      emit(rt, 'batch', { ...batchSummary(id), current: { id: ch.id, idx: ch.idx, title: ch.title } });

      const ctx = chapterContext(p, ch);
      ctx.target = chapterTarget(p, ch);
      const { system, user } = P.chapterWrite(p, ch, ctx);
      rt.abort = new AbortController();
      let acc = '';
      const out = await callAI({
        task: 'writer', step: 'write', system, user,
        projectId: p.id, chapterId: ch.id, stream: true, signal: rt.abort.signal,
        onDelta: (d) => { acc += d; emit(rt, 'delta', { chapterId: ch.id, idx: ch.idx, text: d }); },
        mock: () => M.chapterContent(p, ch, mockCtx(ch, ctx), ctx.target),
      });
      rt.abort = null;
      const text = out.text || acc;
      const saved = await saveChapterContent(p, ch, text, { reason: 'batch', sync: b.sync === 1, forceSnapshot: true });

      const fresh = get('SELECT * FROM chapters WHERE id = ?', ch.id);
      let reviewScore = null;
      if (b.review === 1 && fresh) {
        try {
          const rv = await reviewChapter(p, { ...fresh, cast: parseField(fresh.cast_names, []), review: null });
          reviewScore = rv.score;
        } catch (e) {
          emit(rt, 'warning', { chapterId: ch.id, message: `第 ${ch.idx} 章检查失败：${e.message || e}` });
        }
      }

      const after = batchRow(id);
      updateBatch(id, {
        cursor_idx: ch.idx,
        done_chapters: (after?.done_chapters || 0) + 1,
        words_added: (after?.words_added || 0) + saved.wordCount,
        message: `刚写完第 ${ch.idx} 章《${ch.title || '未命名'}》`,
        updated_at: now(),
      });
      emit(rt, 'chapter', {
        chapterId: ch.id,
        idx: ch.idx,
        title: ch.title,
        wordCount: saved.wordCount,
        summary: saved.summary || '',
        synced: saved.synced?.length || 0,
        reviewScore,
        totalWords: countWords(text),
      });
      emit(rt, 'batch', batchSummary(id));
    }
  } catch (e) {
    if (rt.cancelled) {
      updateBatch(id, { status: 'cancelled', message: '已取消', updated_at: now() });
    } else {
      updateBatch(id, { status: 'error', message: `已停止：${e?.message || e}`, updated_at: now() });
      emit(rt, 'error', { message: e?.message || String(e) });
    }
    emit(rt, 'batch', batchSummary(id));
  } finally {
    rt.running = false;
    rt.abort = null;
    /* 任务结束（完成 / 暂停 / 取消 / 出错）后关闭进度流，页面可重新 attach */
    for (const res of rt.subs) {
      try { res.end(); } catch { /* 忽略 */ }
    }
    rt.subs.clear();
  }
}
