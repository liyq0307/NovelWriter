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
import { runSkill, registerSkill } from '../server/src/skills/registry.js';
import { buildFlavorPrompt } from '../server/src/skills/deai.js';

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

/** 预期失败的请求：返回状态码与响应体，不抛错 */
async function apiFail(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json };
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

  const relOk = await api('POST', `/projects/${p.id}/relations`, { from: '测试路人', to: c.characters[0].name, type: '旧识', description: '冒烟测试' });
  ok('手动新增关系（双方角色名）', relOk.from_name === '测试路人' && relOk.to_name === c.characters[0].name, `${relOk.from_name} → ${relOk.to_name}`);
  const relLegacy = await api('POST', `/projects/${p.id}/relations`, { from_name: c.characters[0].name, to_name: c.characters[1].name });
  ok('关系接口兼容 from_name/to_name', relLegacy.from_name === c.characters[0].name && relLegacy.type === '关系');
  const specialName = '阿“七”·<风>&\'';
  const relSpecial = await api('POST', `/projects/${p.id}/relations`, { from: specialName, to: '测试路人', type: '旧识〈特殊〉', description: '引号 & 尖括号' });
  ok('特殊字符角色名可保存', relSpecial.from_name === specialName && relSpecial.type === '旧识〈特殊〉');
  const relMissTo = await apiFail('POST', `/projects/${p.id}/relations`, { from: '测试路人' });
  ok('缺少角色 B 正确报错', relMissTo.status === 400 && relMissTo.json?.error === '关系需要双方角色名');
  const relBlank = await apiFail('POST', `/projects/${p.id}/relations`, { from: '   ', to: '测试路人' });
  ok('空白角色名正确报错', relBlank.status === 400 && relBlank.json?.error === '关系需要双方角色名');

  console.log('▶ 架构规划');
  const o = await api('POST', `/projects/${p.id}/outline`, {});
  ok('AI 生成卷纲', o.volumes.length === 3, o.volumes.map((v) => v.title).join(' / '));
  const cp = await api('POST', `/projects/${p.id}/volumes/${o.volumes[0].id}/plan`, {});
  ok('AI 拆章', cp.chapters.length === 8 && cp.chapters.every((ch) => ch.brief && ch.hook), `共 ${cp.chapters.length} 章`);
  const ch1 = cp.chapters[0];
  ok('出场人物绑定角色库', ch1.cast.every((n) => c.characters.some((x) => x.name === n)), `cast: ${ch1.cast.join('、')}`);

  const manual = await api('POST', `/projects/${p.id}/chapters`, { volumeId: null, title: '手动分卷外章节', brief: '手动创建，用于验证未分卷展示' });
  ok('手动加章带默认状态与排序', manual.status === 'planned' && manual.volume_id === null && manual.idx > 0, `idx ${manual.idx} · ${manual.status}`);
  const manualDraft = await api('PUT', `/projects/${p.id}/chapters/${manual.id}`, { status: 'draft' });
  ok('手动章节状态可切换', manualDraft.status === 'draft');
  const manualNamed = await api('PUT', `/projects/${p.id}/chapters/${manual.id}`, { title: '标题含“引号”与<符号>' });
  ok('手动章节标题支持特殊字符', manualNamed.title === '标题含“引号”与<符号>');
  const pManual = await api('GET', `/projects/${p.id}`);
  const orphan = pManual.chapters.find((c) => c.id === manual.id);
  ok('未分卷手动章节仍随作品返回', !!orphan && orphan.volume_id === null && orphan.status === 'draft');

  const doneCh = await api('PUT', `/projects/${p.id}/chapters/${manual.id}`, { status: 'done' });
  ok('章节状态可手动标记为完成', doneCh.status === 'done');
  const badStatus = await apiFail('PUT', `/projects/${p.id}/chapters/${manual.id}`, { status: 'finished' });
  ok('非法章节状态被拒绝', badStatus.status === 400 && badStatus.json?.error === '章节状态不合法');

  const nv = await api('POST', `/projects/${p.id}/volumes`, { title: '第四卷·测试新增卷', summary: '手动新增卷的简介' });
  ok('新增卷成功且顺序递增', nv.ok === true && nv.idx === 4 && nv.title === '第四卷·测试新增卷', `第${nv.idx}卷`);
  const nvGet = await api('GET', `/projects/${p.id}/volumes/${nv.id}`);
  ok('按 ID 查询卷回显完整信息', nvGet.id === nv.id && nvGet.chapterCount === 0 && Array.isArray(nvGet.chapters));
  const nvDup = await apiFail('POST', `/projects/${p.id}/volumes`, { title: '第四卷·测试新增卷' });
  ok('新增卷重名校验', nvDup.status === 400 && nvDup.json?.error === '已存在同名卷，请换一个卷名');
  const nvBlank = await apiFail('POST', `/projects/${p.id}/volumes`, { title: '   ' });
  ok('新增卷卷名必填', nvBlank.status === 400 && nvBlank.json?.error === '卷名不能为空');
  const nvLong = await apiFail('POST', `/projects/${p.id}/volumes`, { title: '长'.repeat(81) });
  ok('新增卷卷名长度校验', nvLong.status === 400 && /80/.test(nvLong.json?.error || ''));
  const nvPut = await api('PUT', `/projects/${p.id}/volumes/${nv.id}`, { title: '第四卷·改名后', summary: '更新后的简介' });
  ok('编辑卷保存修改', nvPut.ok === true && nvPut.title === '第四卷·改名后' && nvPut.summary === '更新后的简介');
  const nvGet2 = await api('GET', `/projects/${p.id}/volumes/${nv.id}`);
  ok('编辑结果已持久化', nvGet2.title === '第四卷·改名后' && nvGet2.idx === 4);
  const nvMissing = await apiFail('GET', `/projects/${p.id}/volumes/999999`);
  ok('不存在的卷返回清晰错误', nvMissing.status === 404 && nvMissing.json?.error === '卷不存在');
  const nvNoProj = await apiFail('GET', `/projects/999999/volumes/${nv.id}`);
  ok('无权限/作品不存在时拦截', nvNoProj.status === 404 && nvNoProj.json?.error === '作品不存在');

  const cp2 = await api('POST', `/projects/${p.id}/volumes/${o.volumes[1].id}/plan`, {});
  const v2Chapters = cp2.chapters.filter((c) => c.volume_id === o.volumes[1].id);
  ok('第二卷拆章正常落库', v2Chapters.length === 8 && v2Chapters.every((c) => c.title && c.brief && c.hook), `第二卷 ${v2Chapters.length} 章`);
  const cp2b = await api('POST', `/projects/${p.id}/volumes/${o.volumes[1].id}/plan`, {});
  ok('重复拆章替换旧规划而不叠加', cp2b.chapters.filter((c) => c.volume_id === o.volumes[1].id).length === 8 && cp2b.replaced === 8,
    `替换 ${cp2b.replaced} 章 · 新生成 ${cp2b.planned} 章`);
  const cp3 = await api('POST', `/projects/${p.id}/volumes/${o.volumes[2].id}/plan`, {});
  const v3Chapters = cp3.chapters.filter((c) => c.volume_id === o.volumes[2].id);
  ok('其他卷拆章功能一致', v3Chapters.length === 8 && v3Chapters.every((c) => c.title && c.brief), `第三卷 ${v3Chapters.length} 章`);

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
  const revsAfterRestore = await api('GET', `/projects/${p.id}/chapters/${ch1.id}/revisions`);
  const prevWc = full.slice(0, 300).replace(/\s/g, '').length;
  ok('回滚前正文留档', revsAfterRestore.some((r) => r.reason === 'restore-prev' && r.word_count === prevWc));
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
  const ctx = await api('GET', `/projects/${p.id}/chapters/${ch1.id}/context`);
  ok('本章上下文预览', ctx.promptChars > 0 && ctx.target > 0 && ctx.world.length > 0 && ctx.characters.length > 0,
    `${ctx.promptChars} 字 / 约 ${ctx.promptTokens} tokens / 召回 ${ctx.recalls.length} 条`);
  await api('PUT', `/projects/${p.id}/chapters/${ch1.id}/content?force=1&reason=pre-revise`, { content: full });
  const preRevs = await api('GET', `/projects/${p.id}/chapters/${ch1.id}/revisions`);
  ok('修文前强制留档', preRevs.some((r) => r.reason === 'pre-revise'));
  const reviseEvents = await sse(`/projects/${p.id}/chapters/${ch1.id}/revise`, { review: rv.review });
  const reviseDone = reviseEvents.find((e) => e.ev === 'done');
  ok('按检查意见修文（流式）', !!reviseDone && reviseDone.data.text.length > 800 && reviseDone.data.mock === true,
    `${reviseDone?.data.wordCount ?? 0} 字`);
  const accepted = await api('PUT', `/projects/${p.id}/chapters/${ch1.id}/content?sync=1&reason=revise`, { content: reviseDone.data.text });
  ok('修文结果可采纳', accepted.ok === true);
  const afterRevise = await api('GET', `/projects/${p.id}/chapters/${ch1.id}`);
  ok('修文后旧检查失效', afterRevise.review === null);
  const reviseRevs = await api('GET', `/projects/${p.id}/chapters/${ch1.id}/revisions`);
  ok('修文自动留档', reviseRevs.some((r) => r.reason === 'revise'));
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

  const saveShort = await api('PUT', `/projects/${sp.id}/chapters/${sch1.id}/content?reason=manual`, { content: sDone.data.text });
  ok('短篇正文入库', saveShort.ok === true && saveShort.wordCount > 500);

  const sReplan = await api('POST', `/projects/${sp.id}/volumes/${so.volumes[0].id}/plan`, {});
  const sKeep = await api('GET', `/projects/${sp.id}/chapters/${sch1.id}`);
  const sVol1Count = (await api('GET', `/projects/${sp.id}`)).chapters.filter((c) => c.volume_id === so.volumes[0].id).length;
  ok('重新拆章保留正文并替换旧规划',
    sReplan.writtenChapters === 1 && sReplan.replaced === 1 && sReplan.planned === 1
      && sKeep.content === sDone.data.text && sVol1Count === 2,
    `保留 ${sReplan.writtenChapters} 章正文 · 替换 ${sReplan.replaced} 章规划 · 新生成 ${sReplan.planned} 章`);

  const sBefore = await api('GET', `/projects/${sp.id}`);
  const outlineNoMode = await apiFail('POST', `/projects/${sp.id}/outline`, {});
  ok('已有正文时卷纲需显式选择',
    outlineNoMode.status === 409 && outlineNoMode.json?.code === 'HAS_WRITTEN_CHAPTERS' && outlineNoMode.json.stats.written >= 1,
    outlineNoMode.json?.error);
  const skipRes = await api('POST', `/projects/${sp.id}/outline`, { mode: 'skip' });
  const sAfterSkip = await api('GET', `/projects/${sp.id}`);
  const sWritten = await api('GET', `/projects/${sp.id}/chapters/${sch1.id}`);
  const snapChapters = (p) => p.chapters.map((c) => `${c.id}:${c.idx}:${c.volume_id}:${c.title}:${c.status}:${c.word_count}`).join('|');
  const snapVolumes = (p) => p.volumes.map((v) => `${v.id}:${v.idx}:${v.title}:${v.summary}`).join('|');
  ok('跳过模式完整保留章节与卷纲',
    snapChapters(sAfterSkip) === snapChapters(sBefore) && snapVolumes(sAfterSkip) === snapVolumes(sBefore)
      && sWritten.content === sDone.data.text && sWritten.word_count === sDone.data.wordCount,
    `保留 ${skipRes.preservedChapters} 章 · 追加 ${skipRes.addedVolumes} 卷`);
  const overwriteRes = await api('POST', `/projects/${sp.id}/outline`, { mode: 'overwrite' });
  const sAfterOver = await api('GET', `/projects/${sp.id}`);
  ok('覆盖模式清空旧章节并重建卷纲',
    overwriteRes.deletedChapters === sBefore.chapters.length && sAfterOver.chapters.length === 0 && sAfterOver.volumes.length === 4,
    `删除 ${overwriteRes.deletedChapters} 章 · 新建 ${sAfterOver.volumes.length} 卷`);

  console.log('▶ 去AI味 skills');
  const skillList = await api('GET', '/flavor/skills');
  const deai = skillList.skills?.find((s) => s.id === 'deai-humanizer');
  ok('去AI味 skill 已注册', !!deai && ['detect', 'rewrite', 'repair'].every((c) => deai.capabilities.includes(c)) && deai.source?.length === 2);
  const skillPrompt = buildFlavorPrompt('rewrite', { selection: '他缓缓抬起头。' });
  ok('提示词载入两个仓库的原文规则',
    skillPrompt.skill === 'deai-humanizer'
      && skillPrompt.system.includes('中文去 AI 味')
      && skillPrompt.system.includes('人类区间提醒'));
  const fScan = await api('POST', `/projects/${p.id}/chapters/${ch1.id}/flavor-scan`, {});
  ok('扫描返回风险等级与分数', typeof fScan.score === 'number' && !!fScan.level, `${fScan.level} · ${fScan.score}`);
  const fw = await sse(`/projects/${p.id}/chapters/${ch1.id}/flavor-rewrite`, { selection: '他缓缓抬起头，仿佛明白了什么。', hits: [] });
  const fwDone = fw.find((e) => e.ev === 'done');
  ok('改写结果标记由 skill 处理', fwDone?.data?.skill === 'deai-humanizer' && fwDone?.data?.degraded === false);
  registerSkill({ id: 'test-broken', capabilities: ['rewrite'], rewrite() { throw new Error('故意失败'); } });
  const degraded = runSkill('test-broken', 'rewrite', {}, () => ({ system: 'fallback-system', user: 'fallback-user' }));
  ok('skill 异常时自动降级', degraded.skill === 'builtin' && degraded.degraded === true && degraded.system === 'fallback-system');

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
