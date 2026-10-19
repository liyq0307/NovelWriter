/**
 * NovelWriter 全链路冒烟测试（Mock 演示模式，无需 API Key）
 * 覆盖：建书 → 方向 → 世界 → 角色 → 卷纲 → 拆章 → 正文(SSE) → 保存+状态同步 → 检查 → 续写 → 改写 → 导出 → 用量 → 规则
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

  console.log('▶ 保存与状态同步');
  const save1 = await api('PUT', `/projects/${p.id}/chapters/${ch1.id}/content?sync=1`, { content: full });
  ok('正文保存', save1.ok && save1.wordCount === done.data.wordCount && save1.status === 'draft');
  ok('写后角色状态同步', Array.isArray(save1.synced) && save1.synced.length > 0, save1.synced?.map((s) => s.name).join('、'));
  const p3 = await api('GET', `/projects/${p.id}`);
  ok('全书进度更新', p3.status === 'writing' && p3.word_total > 800, `状态 ${p3.status} · ${p3.word_total} 字`);

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
  ok('手动状态同步', Array.isArray(manualSync.updated));

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

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.error('\n💥 冒烟测试异常：', e.message); process.exitCode = 1; })
  .finally(() => {
    if (server) server.kill();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
