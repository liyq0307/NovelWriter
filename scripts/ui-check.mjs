/**
 * UI 冒烟检查：用本机 Edge 无头模式走一遍主要页面并截图。
 * 前提：服务端已运行在 127.0.0.1:4680（生产模式托管 client/dist）。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://127.0.0.1:4680';
const OUT = 'docs/ui';

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  📸 ${name}.png`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function text() {
  return page.evaluate(() => document.body.innerText);
}

try {
  // 1. 书架
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await sleep(600);
  let t = await text();
  console.log('书架:', t.includes('我的书架') && t.includes('新建作品') && t.includes('载入示例作品') ? 'OK' : 'FAIL\n' + t.slice(0, 300));

  // 2. 载入示例作品（幂等），进入概览
  const demoBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('载入示例')));
  if (demoBtn && demoBtn.asElement()) {
    await demoBtn.asElement().click();
    await sleep(1500);
  } else {
    const bookCards = await page.$$('.book-card');
    if (bookCards.length > 1) { await bookCards[0].click(); await sleep(900); }
  }
  t = await text();
  console.log('概览页:', t.includes('本书方向') || t.includes('创作约定') ? 'OK' : 'FAIL\n' + t.slice(0, 300));
  await shot('02-overview');
  const pid = new URL(page.url()).pathname.split('/')[2] || '1';

  // 回到书架补一张有示例书的截图，再进入项目继续检查
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await sleep(600);
  await shot('01-bookshelf');
  await page.goto(`${BASE}/p/${pid}`, { waitUntil: 'networkidle2' });
  await sleep(600);

    // 3. 世界手册
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('.project-nav a')];
      links.find((a) => a.textContent.includes('世界手册'))?.click();
    });
    await sleep(700);
    t = await text();
    console.log('世界手册:', t.includes('世界手册') || t.includes('地理') ? 'OK' : 'FAIL\n' + t.slice(0, 200));
    await shot('03-world');

    // 4. 角色库
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('.project-nav a')];
      links.find((a) => a.textContent.includes('角色库'))?.click();
    });
    await sleep(700);
    await shot('04-characters');

    // 5. 架构规划
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('.project-nav a')];
      links.find((a) => a.textContent.includes('架构规划'))?.click();
    });
    await sleep(700);
    t = await text();
    console.log('架构规划:', t.includes('卷') || t.includes('章') ? 'OK' : 'FAIL\n' + t.slice(0, 200));
    await shot('05-plan');

    // 6. 写作台
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('.project-nav a')];
      links.find((a) => a.textContent.includes('写作台'))?.click();
    });
    await sleep(1000);
    t = await text();
    console.log('写作台:', t.includes('本章任务') && t.includes('生成本章') ? 'OK' : 'FAIL\n' + t.slice(0, 300));
    await shot('06-writer');

    // 6.4 切到第四章（示例中尚未写），避免生成测试覆盖第一章示例正文
    await page.evaluate(() => {
      [...document.querySelectorAll('.ch-item')].find((x) => x.textContent.includes('四·借火'))?.click();
    });
    await sleep(700);

    // 6.5 浏览器内真实流式生成（跟随写入 → 自动保存 → 状态同步）
    page.on('dialog', (d) => d.accept());
    const genBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('生成本章')));
    if (genBtn && genBtn.asElement()) {
      await genBtn.asElement().click();
      // 轮询等待生成完成（最多 30s）：编辑器出现「已保存」且字数 > 0
      let genOk = false;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        t = await text();
        if (t.includes('已保存') && !t.includes('生成中') && !t.includes('AI 正在写本章')) { genOk = true; break; }
      }
      t = await text();
      const words = t.match(/(\d+) 字/);
      console.log('流式生成+自动保存:', genOk && words && Number(words[1]) > 500 ? `OK（${words[1]} 字）` : 'FAIL');
      console.log('角色状态同步:', t.includes('已同步角色状态') || t.includes('写后整理') ? 'OK' : '（未见提示）');
      await shot('06b-generated');
    }

    // 6.8 历史版本与批量连写弹窗
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '历史版本')?.click();
    });
    await sleep(700);
    t = await text();
    console.log('历史版本弹窗:', t.includes('历史版本 · 第') && t.includes('当前正文存档') ? 'OK' : 'FAIL\n' + t.slice(-300));
    await shot('06c-history');
    await page.evaluate(() => document.querySelector('.modal button[aria-label="关闭"]')?.click());
    await sleep(300);

    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '批量连写')?.click();
    });
    await sleep(400);
    t = await text();
    console.log('批量连写弹窗:', t.includes('批量连写') && t.includes('起始章') && t.includes('开始连写') ? 'OK' : 'FAIL\n' + t.slice(-300));
    await shot('06d-batch');
    await page.evaluate(() => document.querySelector('.modal button[aria-label="关闭"]')?.click());
    await sleep(300);

    // 7. 写作台内点击 AI 检查（有正文后应返回评分）
    const reviewBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('AI 检查本章')));
    if (reviewBtn) {
      await reviewBtn.asElement().click();
      await sleep(2500);
      t = await text();
      const score = t.match(/(\d{2})\s*分/);
      console.log('AI 检查:', score ? `OK（${score[1]} 分）` : 'FAIL\n' + t.slice(0, 200));
      await shot('07-review');
    }

    // 7.5 伏笔线索
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('.project-nav a')];
      links.find((a) => a.textContent.includes('伏笔线索'))?.click();
    });
    await sleep(700);
    t = await text();
    console.log('伏笔线索:', t.includes('进行中') && t.includes('从正文补录') ? 'OK' : 'FAIL\n' + t.slice(0, 200));
    await shot('07b-threads');

    // 8. 规则页
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('.project-nav a')];
      links.find((a) => a.textContent.includes('写法规则'))?.click();
    });
    await sleep(700);
    t = await text();
    console.log('写法规则:', t.includes('反 AI 规则') || t.includes('反AI规则') ? 'OK' : 'FAIL');
    await shot('08-rules');

    // 9. 用量页
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('.project-nav a')];
      links.find((a) => a.textContent.includes('AI 用量'))?.click();
    });
    await sleep(800);
    t = await text();
    console.log('AI 用量:', t.includes('运行记录') || t.includes('调用次数') ? 'OK' : 'FAIL');
    await shot('09-usage');

  // 10. 新书向导（方向页）
  await page.goto(`${BASE}/p/${pid}/direction`, { waitUntil: 'networkidle2' });
  await sleep(800);
  t = await text();
  console.log('方向页:', t.includes('方向') ? 'OK' : 'FAIL\n' + t.slice(0, 200));
  await shot('10-direction');

  // 11. 设置页
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle2' });
  await sleep(800);
  t = await text();
  console.log('设置页:', t.includes('模型设置') && t.includes('Mock 演示模式') ? 'OK' : 'FAIL\n' + t.slice(0, 200));
  await shot('11-settings');

  console.log(errors.length ? `\n⚠ 页面错误 ${errors.length} 条：\n` + errors.slice(0, 10).join('\n') : '\n✓ 无前端运行时错误');
} finally {
  await browser.close();
}
