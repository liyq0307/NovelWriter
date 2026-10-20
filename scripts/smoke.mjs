/**
 * NovelWriter 全链路冒烟测试（Mock 演示模式，无需 API Key）
 * 覆盖：建书 → 方向 → 世界 → 角色 → 卷纲 → 拆章 → 正文(SSE) → 保存+写后整理 → 检查 → 续写 → 改写
 *      → 版本回滚 → 伏笔线索 → 码字统计 → 批量连写 → 导出 → 用量 → 规则
 * 运行：npm run smoke
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}/api`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwriter-smoke-'));
let server = null;
let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

/** 读取 SSE 流（POST） */
async function sse(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`SSE ${url} -> HTTP ${res.status}`);
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) events.push({ ev, data: JSON.parse(data) });
    }
  }
  return events;
}

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('服务未在预期时间内就绪');
}

async function main() {
  console.log('▶ 启动被测服务（隔离数据目录）');
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(import.meta.dirname, '../server'),
    env: { ...process.env, PORT: String(PORT), NW_HOME: home, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const health = await waitHealth();
  ok('健康检查', health.ok === true && health.mock === true);

  console.log('▶ 建书与开书向导');
  const p = await api('POST', '/projects', { premise: '一个能听见死者执念的点灯人，在戒严的城市里追查三十年前全城灯火熄灭之谜', type: 'novel' });
  ok('创建作品', !!p.id && p.status === 'idea');
  const ds = await api('POST', `/projects/${p.id}/directions`, {});
  ok('AI 生成候选方向', Array.isArray(ds) && ds.length === 3 && ds[0].contract?.pov, ds.map((d) => d.title).join(' / '));
  await api('PATCH', `/projects/${p.id}`, { direction: ds[0], contract: ds[0].contract, status: 'direction', title: ds[0].title });
  const p2 = await api('GET', `/projects/${p.id}`);
  ok('选定方向并落库', p2.direction?.title === ds[0].title && p2.status === 'direction');

  console.log('▶ 世界与角色');
  const w = await api('POST', `/projects/${p.id}/world/generate`, {});
  ok('AI 起草世界设定', w.added >= 4 && w.entries.length >= 4, `新增 ${w.added} 条`);
  const wAdd = await api('POST', `/projects/${p.id}/world`, { category: '其他', name: '手工条目', content: '作者手写的设定' });
  ok('手工新增设定', !!wAdd.id && wAdd.source === 'human');
  const c = await api('POST', `/projects/${p.id}/characters/generate`, {});
  ok('AI 起草角色与关系', c.added >= 3 && c.relAdded >= 2, `角色 ${c.added} / 关系 ${c.relAdded}`);
  const cAdd = await api('POST', `/projects/${p.id}/characters`, { name: '测试路人', role: '配角', profile: '冒烟测试用' });
  const cUpd = await api('PUT', `/projects/${p.id}/characters/${cAdd.id}`, { status: '在东市闲逛' });
  ok('角色编辑', cUpd.status === '在东市闲逛');

  console.log('▶ 架构规划');
  const o = await api('POST', `/projects/${p.id}/outline`, {});
  ok('AI 生成卷纲', o.volumes.length === 3, o.volumes.map((v) => v.title).join(' / '));
  const cp = await api('POST', `/projects/${p.id}/volumes/${o.volumes[0].id}/plan`, {});
  ok('AI 拆章', cp.chapters.length === 8 && cp.chapters.every((ch) => ch.brief && ch.hook), `共 ${cp.chapters.length} 章`);
  const ch1 = cp.chapters[0];
  ok('出场人物绑定角色库', ch1.cast.every((n) => c.characters.some((x) => x.name === n)), `cast: ${ch1.cast.join('、')}`);

  console.log('▶ 写作（SSE 流式）');
  const events = await sse(`/projects/${p.id}/chapters/${ch1.id}/write`, {});
  const deltas = events.filter((e) => e.ev === 'delta');
  const done = events.find((e) => e.ev === 'done');
  ok('流式输出', deltas.length >= 10 && !!done, `${deltas.length} 个增量帧`);
  const full = done.data.text;
  ok('正文完整', full.length > 800 && full.includes(ch1.hook.slice(0, 8)), `${done.data.wordCount} 字`);

  console.log('▶ 保存与写后整理');
  const save1 = await api('PUT', `/projects/${p.id}/chapters/${ch1.id}/content?sync=1&reason=generate`, { content: full });
  ok('正文保存', save1.ok && save1.wordCount === done.data.wordCount && save1.status === 'draft');
  ok('写后角色状态同步', Array.isArray(save1.synced) && save1.synced.length > 0, save1.synced?.map((s) => s.name).join('、'));
  ok('写后生成章节摘要', typeof save1.summary === 'string' && save1.summary.length > 10, save1.summary?.slice(0, 40));
  const pThreads = await api('GET', `/projects/${p.id}/threads`);
  ok('伏笔线索回流', pThreads.length >= 1 && save1.threads >= 1, `线索 ${pThreads.length} 条`);
  const p3 = await api('GET', `/projects/${p.id}`);
  ok('全书进度更新', p3.status === 'writing' && p3.word_total > 800, `状态 ${p3.status} · ${p3.word_total} 字`);

  console.log('▶ 版本历史 / 码字统计 / 线索维护');
  await api('PUT', `/projects/${p.id}/chapters/${ch1.id}/content?force=1&reason=manual`, { content: full.slice(0, 300) });
  const revs = await api('GET', `/projects/${p.id}/chapters/${ch1.id}/revisions`);
  ok('正文版本快照', revs.length >= 2 && revs.some((r) => r.reason === 'generate'), `${revs.length} 个版本`);
  const fullRev = revs[revs.length - 1];
  const restored = await api('POST', `/projects/${p.id}/chapters/${ch1.id}/revisions/${fullRev.id}/restore`, {});
  ok('版本回滚', restored.chapter.content.length === full.length && restored.chapter.word_count === done.data.wordCount);
  const stats = await api('GET', `/stats?projectId=${p.id}`);
  ok('码字统计', stats.days.length === 14 && stats.today > 0 && stats.total > 0, `今日 ${stats.today} 字 · 连续 ${stats.streak} 天`);
  const ext = await api('POST', `/projects/${p.id}/threads/extract`, {});
  ok('从正文补录线索', Array.isArray(ext.threads) && ext.added >= 1, `新增 ${ext.added} 条`);
  const tAdd = await api('POST', `/projects/${p.id}/threads`, { name: '冒烟测试线索', kind: '伏笔', detail: '测试用' });
  const tUpd = await api('PUT', `/projects/${p.id}/threads/${tAdd.id}`, { status: 'resolved' });
  ok('线索人工维护', tUpd.status === 'resolved');

  console.log('▶ 检查与修文');
  const rv = await api('POST', `/projects/${p.id}/chapters/${ch1.id}/review`, {});
  ok('AI 章节检查', typeof rv.review.score === 'number' && Array.isArray(rv.review.issues), `评分 ${rv.review.score} · ${rv.review.issues.length} 个问题`);
  const cont = await sse(`/projects/${p.id}/chapters/${ch1.id}/continue`, { content: full, cursor: full.length, target: 300 });
  const contDone = cont.find((e) => e.ev === 'done');
  ok('光标续写（流式）', !!contDone && contDone.data.text.length > 100);
  const rw = await sse(`/projects/${p.id}/chapters/${ch1.id}/rewrite`, { selection: full.slice(0, 120), instruction: '更冷峻', before: '', after: full.slice(120, 220) });
  const rwDone = rw.find((e) => e.ev === 'done');
  ok('选中改写（流式）', !!rwDone && rwDone.data.text.length > 50);
  const manualSync = await api('POST', `/projects/${p.id}/chapters/${ch1.id}/sync-state`, {});
  ok('手动写后整理', Array.isArray(manualSync.updated) && typeof manualSync.summary === 'string');

  console.log('▶ 批量连写（暂停 / 恢复）');
  const bch1 = cp.chapters[1];
  const bch2 = cp.chapters[2];
  const bch3 = cp.chapters[3];
  const batch = await api('POST', `/projects/${p.id}/batches`, {
    fromIdx: bch1.idx, toIdx: bch3.idx, review: false, sync: true,
  });
  ok('创建连写任务', !!batch.id && batch.status === 'running', `第 ${batch.from_idx}—${batch.to_idx} 章`);

  let bstate = batch;
  for (let i = 0; i < 120; i++) {
    await sleep(200);
    bstate = await api('GET', `/projects/${p.id}/batches/${batch.id}`);
    if (bstate.done_chapters >= 1 || ['done', 'error', 'cancelled'].includes(bstate.status)) break;
  }
  let pausedOk = false;
  if (bstate.status !== 'done') {
    await api('POST', `/projects/${p.id}/batches/${batch.id}/pause`, {});
    for (let i = 0; i < 120; i++) {
      await sleep(200);
      bstate = await api('GET', `/projects/${p.id}/batches/${batch.id}`);
      if (bstate.status === 'paused' || bstate.status === 'done') break;
    }
    pausedOk = bstate.status === 'paused';
    ok('连写暂停', pausedOk, `已完成 ${bstate.done_chapters} 章`);
    if (pausedOk) {
      await api('POST', `/projects/${p.id}/batches/${batch.id}/resume`, {});
      for (let i = 0; i < 200; i++) {
        await sleep(200);
        bstate = await api('GET', `/projects/${p.id}/batches/${batch.id}`);
        if (['done', 'error', 'cancelled', 'paused'].includes(bstate.status)) break;
      }
    }
  }
  ok('批量连写完成', bstate.status === 'done' && bstate.done_chapters === 3, `${bstate.done_chapters} 章 · ${bstate.words_added} 字`);
  const pBatch = await api('GET', `/projects/${p.id}`);
  const written = pBatch.chapters.filter((c) => [bch1.idx, bch2.idx, bch3.idx].includes(c.idx) && c.word_count > 500);
  ok('连写章节已落库', written.length === 3, written.map((c) => `第${c.idx}章 ${c.word_count}字`).join(' / '));
  ok('连写章节摘要齐全', written.every((c) => c.summary && c.summary.length > 10));

  const streamCh = cp.chapters[4];
  const streamBatch = await api('POST', `/projects/${p.id}/batches`, {
    fromIdx: streamCh.idx, toIdx: streamCh.idx, review: false, sync: false,
  });
  const streamEvents = await sse(`/projects/${p.id}/batches/${streamBatch.id}/attach`, {});
  const streamChapter = streamEvents.find((e) => e.ev === 'chapter');
  const streamDone = streamEvents.find((e) => e.ev === 'done');
  ok('连写进度流（SSE）', !!streamChapter && !!streamDone && streamEvents.some((e) => e.ev === 'delta'), `${streamEvents.length} 个事件`);

  console.log('▶ 导出 / 用量 / 规则');
  const exp = await fetch(`${BASE}/projects/${p.id}/export?format=md`);
  const md = await exp.text();
  ok('Markdown 导出', exp.ok && md.includes(`# ${ds[0].title}`) && md.includes(`第${ch1.idx}章`), `${md.length} 字符`);
  const usage = await api('GET', `/usage?projectId=${p.id}`);
  ok('用量统计', usage.totals.calls >= 8 && usage.totals.output_tokens > 0, `调用 ${usage.totals.calls} 次`);
  ok('运行记录留痕', usage.rows.length >= 8 && usage.rows.every((r) => r.step));
  const rules = await api('GET', `/rules?projectId=${p.id}`);
  ok('默认规则已内置', rules.some((r) => r.kind === 'anti_ai' && !r.project_id));
  const seeded = await api('POST', '/rules/seed-anti-ai', {});
  ok('补充反AI规则包', seeded.added >= 4, `新增 ${seeded.added} 条`);
  const ruleAdd = await api('POST', '/rules', { projectId: p.id, kind: 'style', name: '测试写法', content: '冒烟测试规则' });
  await api('PUT', `/rules/${ruleAdd.id}`, { enabled: false });
  const rules2 = await api('GET', `/rules?projectId=${p.id}`);
  ok('本书规则启用开关', rules2.some((r) => r.id === ruleAdd.id && r.enabled === 0));

  console.log('▶ 全文检索 / 提示词模板 / 拆书 / 富格式导出');
  const search = await api('GET', `/projects/${p.id}/search?q=${encodeURIComponent('测试路人')}`);
  ok('全文检索命中角色', search.hits.some((h) => h.kind === 'character' && h.title === '测试路人'), `命中 ${search.hits.length} 条`);
  const pt = await api('GET', `/projects/${p.id}/prompt-templates`);
  ok('提示词模板列表', Array.isArray(pt) && pt.length >= 10 && pt.some((t) => t.step === 'write'));
  await api('PUT', `/projects/${p.id}/prompt-templates/write`, { system: '你是冷硬派作者', suffix: '每章至少一次气味描写' });
  const wt = (await api('GET', `/projects/${p.id}/prompt-templates`)).find((t) => t.step === 'write');
  ok('保存本书提示词覆盖', wt?.overridden === true && wt.system.includes('冷硬派') && wt.suffix.includes('气味'));
  await api('PUT', `/projects/${p.id}/prompt-templates/write`, { system: '你是冷硬派作者（第二版）', suffix: '每章至少一次气味描写' });
  const hist = await api('GET', `/projects/${p.id}/prompt-templates/write/history`);
  ok('提示词历史留档', Array.isArray(hist) && hist.length >= 1, `${hist.length} 个版本`);
  await api('POST', `/projects/${p.id}/prompt-templates/write/rollback`, { historyId: hist[0].id });
  const afterRb = (await api('GET', `/projects/${p.id}/prompt-templates`)).find((t) => t.step === 'write');
  ok('提示词回滚', afterRb?.system === '你是冷硬派作者');
  await api('DELETE', `/projects/${p.id}/prompt-templates/write`);
  const afterReset = (await api('GET', `/projects/${p.id}/prompt-templates`)).find((t) => t.step === 'write');
  ok('提示词恢复默认', afterReset?.overridden === false);

  const refText = [
    '第一章 夜行',
    '灯灭了。他站在巷口，听见远处有人在数数。'.repeat(20),
    '第二章 灯下',
    '她把灯罩擦干净，火光在玻璃上晃动。'.repeat(20),
    '第三章 灰烬',
    '天亮之前，他终于看见了那个人的脸。'.repeat(20),
  ].join('\n\n');
  const dec = await api('POST', `/projects/${p.id}/deconstructions`, { title: '参考样本', text: refText });
  ok('拆书自动分章', dec.chapter_count === 3 && dec.status === 'done', `${dec.chapter_count} 章 / ${dec.word_count} 字`);
  ok('拆书结果结构', !!dec.result?.structure?.pattern && dec.result.characters.length >= 3 && dec.result.rules.length >= 4,
    `${dec.result?.characters.length} 人 / ${dec.result?.rules.length} 条规则`);
  const toRules = await api('POST', `/projects/${p.id}/deconstructions/${dec.id}/to-rules`, {});
  ok('拆书规则写入写法库', toRules.added >= 4, `新增 ${toRules.added} 条`);
  await api('DELETE', `/projects/${p.id}/deconstructions/${dec.id}`);
  ok('拆书记录删除', (await api('GET', `/projects/${p.id}/deconstructions`)).length === 0);

  const gd = await api('POST', `/projects/${p.id}/directions`, {
    guide: { genre: '悬疑', sellingPoints: ['悬念反转'], pacing: '快节奏强冲突', audience: '男性向', taboos: '不写系统面板' },
  });
  ok('构思向导生成方向', Array.isArray(gd) && gd.length === 3 && gd.every((x) => x.genre.includes('悬疑')));

  const dx = await fetch(`${BASE}/projects/${p.id}/export?format=docx`);
  const dxBuf = Buffer.from(await dx.arrayBuffer());
  ok('DOCX 导出', dx.ok && dxBuf.subarray(0, 2).toString() === 'PK' && dxBuf.length > 500, `${dxBuf.length} 字节`);
  const ep = await fetch(`${BASE}/projects/${p.id}/export?format=epub`);
  const epBuf = Buffer.from(await ep.arrayBuffer());
  ok('EPUB 导出', ep.ok && epBuf.subarray(0, 2).toString() === 'PK' && epBuf.includes('application/epub+zip'), `${epBuf.length} 字节`);

  console.log('▶ 短篇流程');
  const sp = await api('POST', '/projects', { premise: '深夜便利店打烊前，店员发现收银机多出一张三十年前的纸币', type: 'short', targetWords: 6000 });
  const sds = await api('POST', `/projects/${sp.id}/directions`, {});
  await api('PATCH', `/projects/${sp.id}`, { direction: sds[1], contract: sds[1].contract, status: 'direction' });
  await api('POST', `/projects/${sp.id}/world/generate`, {});
  await api('POST', `/projects/${sp.id}/characters/generate`, {});
  const so = await api('POST', `/projects/${sp.id}/outline`, {});
  ok('短篇分节', so.volumes.length === 4 && so.volumes[0].title.includes('第'), so.volumes.map((v) => v.title).join(' / '));
  const scp = await api('POST', `/projects/${sp.id}/volumes/${so.volumes[0].id}/plan`, {});
  const sch1 = scp.chapters[0];
  const sEvents = await sse(`/projects/${sp.id}/chapters/${sch1.id}/write`, {});
  const sDone = sEvents.find((e) => e.ev === 'done');
  ok('短篇正文（字数按目标分摊）', !!sDone && sDone.data.wordCount > 500, `${sDone.data.wordCount} 字（目标 6000/8 章）`);

  console.log('▶ 示例作品');
  const demo = await api('POST', '/demo', {});
  ok('载入示例作品', demo.created === true && !!demo.project?.id);
  const demoAgain = await api('POST', '/demo', {});
  ok('示例作品幂等', demoAgain.created === false && demoAgain.project.id === demo.project.id);
  const dp = await api('GET', `/projects/${demo.project.id}`);
  ok('示例作品结构完整', dp.volumes.length === 3 && dp.chapters.length === 18 && dp.world.length === 5 && dp.characters.length === 4,
    `${dp.volumes.length} 卷 / ${dp.chapters.length} 章 / ${dp.world.length} 条设定 / ${dp.characters.length} 个角色`);
  ok('示例正文与摘要', dp.chapters.slice(0, 3).every((c) => c.word_count > 500 && c.summary), `已写 ${dp.chapters.filter((c) => c.word_count > 0).length} 章`);
  ok('示例伏笔', dp.threads.length >= 4 && dp.threads.some((t) => t.status === 'resolved'), `线索 ${dp.threads.length} 条`);
  const dStats = await api('GET', `/stats?projectId=${demo.project.id}`);
  ok('示例码字统计', dStats.total > 3000 && dStats.streak >= 3, `${dStats.total} 字 · 连续 ${dStats.streak} 天`);
  const dRevs = await api('GET', `/projects/${demo.project.id}/chapters/${dp.chapters[0].id}/revisions`);
  ok('示例版本历史', dRevs.length >= 2, `${dRevs.length} 个版本`);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.error('\n💥 冒烟测试异常：', e.message); process.exitCode = 1; })
  .finally(() => {
    if (server) server.kill();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
