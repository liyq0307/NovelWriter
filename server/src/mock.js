/**
 * Mock 演示引擎：无 API Key 时也能完整体验「灵感 → 方向 → 世界 → 角色 → 卷纲 → 拆章 → 正文 → 检查 → 同步」全流程。
 * 每个导出函数返回「模型文本」，由 ai.js 在 mock 模式下调用。
 */
import { createHash } from 'node:crypto';
import { clip, countWords } from './util.js';

const seedOf = (s) => createHash('md5').update(String(s ?? '')).digest('hex');
const pick = (arr, seed) => arr[parseInt(seed.slice(0, 6), 16) % arr.length];
const pickN = (arr, seed, n) => {
  const out = [];
  let i = 0;
  while (out.length < Math.min(n, arr.length)) {
    const x = arr[(parseInt(seed.slice((i * 2) % 26, ((i * 2) % 26) + 2), 16) + i) % arr.length];
    if (!out.includes(x)) out.push(x);
    i++;
  }
  return out;
};

const NAMES = ['林渡', '沈疏影', '裴九霄', '阿禾', '顾青崖', '温小满', '陆惊鸿', '苏折枝'];
const PLACES = ['临渊城', '雾隐镇', '朔风渡', '九衢', '白鸦城'];
const HOOKS = [
  '夜色深处，有一盏灯违背全城禁令，亮了。',
  '名单最后一行，写着他自己今年的忌日。',
  '对方抬起头，露出一张和他一模一样的脸。',
  '那句话不是活人说的——声音从井底传来。',
  '门开了，门外站着三年前就该死去的人。',
];

const coreOf = (p) => clip((p.premise || '').replace(/\s+/g, ' '), 24) || '那个没有名字的执念';

/* ---------- 开书方向 ---------- */
export function directions(p, guide = {}) {
  const core = coreOf(p);
  const form = p.type === 'short' ? '短篇' : '长篇';
  const tag = guide.genre ? `${guide.genre}·` : '';
  /* 作者在构思向导里定下的硬约束，Mock 也照此体现 */
  const povOf = (fallback) => guide.pov || fallback;
  const toneOf = (fallback) => guide.tone || fallback;
  const list = [
    {
      title: `${clip(core, 6)}·燎原`,
      genre: `${tag}玄幻·热血`,
      logline: `围绕「${core}」，一个被所有人放弃的少年，在绝境里点燃了自己的道。`,
      sellingPoints: ['层层反转的攀升线', '克制的羁绊描写', '每卷一个里程碑式高潮'],
      protagonist: '外冷内燃的少年，核心欲望是「证明自己配得上被留下」，阻力是出身与旧案的层层围剿。',
      style: '冷叙事包裹热血内核，短句推进，动作场面干净利落。',
      audience: '18-30 岁男频读者',
      contract: { pov: povOf('第三人称限制视角（跟随主角）'), tone: toneOf('克制、凌厉、偶尔温柔'), taboos: ['不写无意义卖萌', '不滥用回忆杀'], arc: '从被驱逐的弃子，到守夜人执灯者。' },
    },
    {
      title: `${clip(core, 6)}·回声`,
      genre: `${tag}悬疑·都市传说`,
      logline: `「${core}」背后牵出一桩三年前的旧案，追查到最后，发现拼图缺失的那块是自己。`,
      sellingPoints: ['双线叙事逐步合流', '每章一个可回溯的伏笔', '真相反转在最后一刻'],
      protagonist: '理性的调查者，核心欲望是「补全真相」，阻力是记忆本身就被人为篡改。',
      style: '冷静白描，信息密度高，靠细节而非形容词制造寒意。',
      audience: '20-35 岁悬疑推理读者',
      contract: { pov: povOf('第一人称不可靠叙事'), tone: toneOf('冷静、压抑、暗流涌动'), taboos: ['不提前剧透关键线索', '不用超自然解释兜底'], arc: '从旁观者到当事人，真相揭晓即身份揭晓。' },
    },
    {
      title: `${clip(core, 6)}·拾光`,
      genre: `${tag}现实·温情成长`,
      logline: `${form}故事：一场与「${core}」有关的告别之后，几个普通人替彼此撑过了最难的一年。`,
      sellingPoints: ['生活流细节扎实', '群像各有弧光', '后劲极大的克制抒情'],
      protagonist: '笨拙而善良的普通人，核心欲望是「留住即将消失的东西」，阻力是时间与各自的怯懦。',
      style: '平实温润，多用生活细节与对话，煽情点到即止。',
      audience: '全年龄通吃，偏好治愈系读者',
      contract: { pov: povOf('第三人称多视角轮转'), tone: toneOf('温暖、克制、微苦回甘'), taboos: ['不写狗血冲突', '不用巧合推进主线'], arc: '从各自离散，到彼此成为归处。' },
    },
  ];
  return JSON.stringify(list, null, 2);
}

/* ---------- 方向融合 ---------- */
export function directionsMerge(p, candidates = [], note = '') {
  const core = coreOf(p);
  const first = candidates[0] || {};
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const joined = (arr) => uniq(arr.map((s) => String(s || '').replace(/[。；;]\s*$/, ''))).join('；');
  const ct = first.contract || {};
  const merged = {
    title: `${clip(core, 6).replace('……', '')}·合流`,
    genre: uniq(candidates.map((c) => c.genre)).join(' / ') || (p.type === 'short' ? '短篇·综合' : '长篇·综合'),
    logline: first.logline || `围绕「${core}」，几条看似无关的线最终拧成同一个答案。`,
    sellingPoints: uniq(candidates.flatMap((c) => c.sellingPoints || [])).slice(0, 5),
    protagonist: first.protagonist || '核心欲望清晰、代价明确的普通人，被一步步逼到必须做出选择的位置。',
    style: joined(candidates.map((c) => c.style)) || '克制白描，短句推进，情绪藏在动作里。',
    audience: first.audience || '偏好强情节与人物弧光的读者',
    contract: {
      pov: ct.pov || '第三人称限知视角（跟随主角）',
      tone: joined(candidates.map((c) => c.contract?.tone)) || '克制、暗流涌动',
      taboos: uniq(candidates.flatMap((c) => c.contract?.taboos || [])).slice(0, 4),
      arc: ct.arc || `围绕「${core}」完成一次从逃避到承担的完整弧线。`,
    },
  };
  if (note) merged.sellingPoints.unshift(`融合取向：${clip(note, 24)}`);
  return JSON.stringify(merged, null, 2);
}

/* ---------- 世界设定 ---------- */
export function world(p) {
  const core = coreOf(p);
  const seed = seedOf('world:' + p.id);
  const place = pick(PLACES, seed);
  const list = [
    { category: '地理', name: place, content: `故事的核心舞台。围绕「${core}」的传闻在东市与旧城墙之间流转；入夜戒严，灯油按户配给，墙根下永远有扫不净的香灰。` },
    { category: '势力', name: '守夜人司', content: '直属于城主的黑衣机构，垄断「点灯」资格的审批。三年前一场大火后元气大伤，如今在暗中重建，名单上空着一排名字。' },
    { category: '规则', name: '回响', content: `强烈的执念会在特定地点留下「回响」——「${core}」是最强的一道。回响只有少数人听得见，代价是逐渐失去自己的记忆。` },
    { category: '物品', name: '褪色的罗盘', content: '黄铜外壳，指针永远指向最近的一道回响；表盘背面刻着一个被利器刮掉的名字，刮痕很深，像怕被人认出来。' },
    { category: '历史', name: '静默之夜', content: '三十年前，全城灯火在一夜之间熄灭。无人记得那一晚发生了什么，官档仅存空壳，亲历者集体缄口，只有童谣残缺地流传下来。' },
  ];
  return JSON.stringify(list, null, 2);
}

/* ---------- 角色与关系 ---------- */
export function characters(p) {
  const core = coreOf(p);
  const seed = seedOf('chars:' + p.id + p.premise);
  const [a, b, c, v] = pickN(NAMES, seed, 4);
  const obj = {
    characters: [
      { name: a, role: '主角', profile: `守夜人司最年轻的候补，因「${core}」被卷入漩涡。外冷内热，重要的话总留到最后一刻才说。`, goals: '查清家人当年的下落，拿回属于自己的名字。', appearance: '墨色短发，左腕一圈旧烧伤，习惯性攥袖口。' },
      { name: b, role: '重要配角', profile: '东市旧货铺的掌柜，消息灵通，什么都卖、什么都不问；与主角互相欠着一条命。', goals: '在乱局里保住铺子和身后那群孩子。', appearance: '洗得发白的靛蓝长衫，笑起来眼睛先弯。' },
      { name: c, role: '重要配角', profile: '城主府年轻幕僚，理性到近乎冷酷，坚信「秩序高于真相」。', goals: '借旧案扳倒政敌，为此可以牺牲任何人。', appearance: '金丝眼镜，指甲永远修剪得干干净净。' },
      { name: v, role: '反派', profile: '前守夜人司首席，静默之夜后销声匿迹；归来时带着一整套关于「回响」的疯狂理论，且每一步都能自圆其说。', goals: '以全城灯火为代价，完成一场「真正的点灯」。', appearance: '左半张脸覆着烧伤的疤，走路没有声音。' },
    ],
    relations: [
      { from: a, to: b, type: '相互亏欠的盟友', description: '一场大火里彼此救过对方的命，谁都不肯先提。' },
      { from: a, to: c, type: '立场对立', description: '一个要真相，一个要秩序，暂时还没到撕破脸的时候。' },
      { from: c, to: v, type: '旧识·各怀鬼胎', description: '档案里同时抹掉了两个人的名字。' },
      { from: a, to: v, type: '猎与被猎', description: '罗盘的指针，永远指向对方。' },
    ],
  };
  return JSON.stringify(obj, null, 2);
}

/* ---------- 卷纲 ---------- */
export function outline(p) {
  const core = coreOf(p);
  if (p.type === 'short') {
    const list = [
      { title: '第一节·来客', summary: `「${core}」以一场意外的形式闯入主角生活，日常被撕开一道口子。结尾钩子：来客留下一样不该存在的东西。` },
      { title: '第二节·旧账', summary: '追查东西的来历，翻出一段被刻意掩埋的旧事；主角发现自己并非局外人。结尾钩子：最信任的人说了谎。' },
      { title: '第三节·对峙', summary: '所有线头汇拢，主角必须在与真相正面相遇之前做出选择。结尾钩子：还剩一次机会。' },
      { title: '第四节·点灯', summary: '结局：代价被支付，灯亮起或熄灭，各归其位。留一个开放而克制的尾声。' },
    ];
    return JSON.stringify(list, null, 2);
  }
  const list = [
    { title: '第一卷·灯下黑', summary: `主角卷入「${core}」事件：身边的失踪案牵出守夜人司的旧疤。他必须在查案与自保之间选边站。卷末钩子：他在三十年前的名单上，看见了自己的名字。` },
    { title: '第二卷·满城灯', summary: '旧案翻案，城内势力重新洗牌。主角获得「点灯」资格，代价是开始遗忘重要的人。卷末钩子：反派现身，说出静默之夜的一半真相。' },
    { title: '第三卷·守夜人', summary: '拼图完整：静默之夜是一场被阻止的献祭。主角要在「记住自己」与「救下全城」之间做最后选择。结尾：灯重新亮起，有人永远留在黑暗里守着。' },
  ];
  return JSON.stringify(list, null, 2);
}

/* ---------- 拆章 ---------- */
export function chapterPlan(p, vol, existingCount) {
  const core = coreOf(p);
  const seed = seedOf('plan:' + p.id + vol.id + vol.title);
  const [a, b] = pickN(NAMES, seed, 2);
  const steps = p.type === 'short' ? ['来客', '旧账'] : ['风起', '暗流', '试探', '交锋', '裂痕', '破局', '代价', '收束'];
  const scenePool = ['东市旧货铺·打烊时分', '旧城墙下·雨夜', '守夜人司档案房·烛尽之前', '城主府偏厅·一场鸿门宴', '排水渠尽头·灯影交界处'];
  const list = steps.map((st, i) => ({
    title: st,
    brief: `推进「${vol.title}」主线：围绕${core}，主角与对手在「${st}」阶段正面接触，完成一个阶段性信息揭示，改变双方的力量认知。`,
    scenes: `${pick(scenePool, seed + i)}：第 ${existingCount + i + 1} 步行动，从一次会面或发现开始，以一次决断结束。`,
    cast: i % 2 === 0 ? [a, b] : [a],
    hook: pick(HOOKS, seed + i * 3),
  }));
  return JSON.stringify(list, null, 2);
}

/* ---------- 章节正文 ---------- */
const FILLER = [
  (x) => `巷子两侧的灯一盏接一盏熄灭，像是整座${x.place}都在为他们让路。`,
  (x) => `${x.a}没有立刻回答。他在数对方呼吸的间隔——三短一长，是守夜人司的汇报暗号，也是老熟人之间才有的习惯。`,
  (x) => `“规矩是死的。”${x.b}把布包往桌上一放，“可立规矩的人，昨夜刚死在旧城墙下。”`,
  (x) => `风从城墙缺口灌进来，吹得图纸哗哗作响。${x.a}伸手压住纸角，指尖触到一行极小的批注，墨迹还很新。`,
  (x) => `远处传来更夫的梆子声，两长一短。${x.place}的夜，从这时辰起就不属于活人了。`,
  (x) => `“你在怕。”${x.b}忽然说。这不是询问，是陈述。`,
  (x) => `${x.a}低头看那枚${x.item}，黄铜外壳上的刮痕在灯下泛着暗红。有些东西一旦知道，就再也没法装作不知道。`,
  (x) => `他们沿着排水渠走了半刻钟。水声盖过脚步声，也盖过那句几乎要出口的解释。`,
  (x) => `图纸铺开时，${x.b}的指尖停在旧城区第七巷——“三年前，最后一盏灯就是在这里熄灭的。”`,
  (x) => `${x.a}闭上眼。那些声音又来了，细碎、断续，像隔着三十年的雨。有人在喊一个名字，声音很像他自己。`,
];

export function chapterContent(p, c, ctx, target) {
  const seed = seedOf(`ch:${c.id}:${c.title}:${c.idx}`);
  const a = ctx.castNames[0] || '林渡';
  const b = ctx.castNames[1] || ctx.otherName || '沈疏影';
  const x = { a, b, place: ctx.place, item: ctx.item };
  const lines = [];
  lines.push('> （Mock 演示正文：未配置 API Key 时用于体验流程。请在「模型设置」中接入真实模型，重新生成即可获得 AI 实际创作。）');
  lines.push('');
  lines.push(`${x.place}的雨说停就停了，檐角最后一滴水砸在青石板上，声音清得过分。`);
  lines.push(`${a}站在原地没动。任务单上写的是「${clip(c.brief, 36)}」，可直觉告诉他，今晚要面对的远不止这些。`);
  lines.push(`“你还留着那东西？”${b}从阴影里走出来，视线落在${a}怀里那枚${x.item}上，“守夜人司找它找了三年。”`);
  lines.push(`${a}把${x.item}往怀里按了按：“它找的，是我。”`);
  const body = [];
  let i = 0;
  while (countWords(body.join('')) < Math.min(target, 1800) && i < 40) {
    body.push(FILLER[(i + parseInt(seed.slice(0, 4), 16)) % FILLER.length](x));
    i++;
  }
  lines.push(...body);
  lines.push(`灯花爆了一下。${b}忽然按住${a}的手腕，压低声音：“别回头——有人在数我们的脚步。”`);
  lines.push('');
  lines.push(`${c.hook || pick(HOOKS, seed)}`);
  return lines.join('\n\n');
}

/* ---------- 续写 / 改写 ---------- */
export function continueText(p, c, before, target) {
  const seed = seedOf('cont:' + c.id + before.length);
  const a = '他';
  const lines = [
    `${a}们贴着墙根停住。脚步声在第七巷口分成两股，一股渐远，一股停在原地——像是在等他们先动。`,
    `${pick(FILLER, seed)( { a: '林渡', b: '沈疏影', place: '临渊城', item: '罗盘' } )}`,
    `空气里有陈年灯油的味道，混着一点若有若无的烧焦。${a}数到第七息，吹灭了手里最后一点火。`,
  ];
  return lines.join('\n\n');
}

/** Mock 演示用的轻量去味：删掉常见模板词，不输出任何前缀或说明 */
function demoDeAiText(text) {
  return String(text || '')
    .replace(/仿佛|似乎|宛如/g, '')
    .replace(/缓缓|微微|轻轻|不由得|莫名地?|隐隐|默默地?|静静地?/g, '')
    .replace(/与此同时|在这瞬间|然而此刻/g, '')
    .replace(/内心深处|难以言喻|无法形容/g, '')
    .replace(/[，,]{2,}/g, '，')
    .replace(/，([。！？])/g, '$1')
    .trim();
}

export function rewriteText(selection) {
  return demoDeAiText(selection) || String(selection || '').trim();
}

/** 去AI味语义诊断演示：从正文里挑一两句模板化表达，演示问题清单与修复闭环 */
export function flavorDetect(text) {
  const sentences = String(text || '')
    .split(/(?<=[。！？!?…])/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const picked = sentences
    .filter((s) => /仿佛|似乎|嘴角|眼神|深吸一口气|缓缓|不由得/.test(s))
    .slice(0, 2)
    .map((s, i) => ({
      ruleId: i === 0 ? 'anti_template_rhythm' : 'anti_static_padding',
      ruleName: i === 0 ? '机械排比 / 均匀句式' : '静态动作填充',
      ruleType: 'risk',
      severity: 'medium',
      excerpt: s.slice(0, 80),
      reason: '（Mock 演示）该句依赖常见 AI 腔模板，信息增量不足。',
      suggestion: '换成具体动作或可观察的后果。',
      canAutoRewrite: true,
    }));
  return JSON.stringify({
    riskScore: picked.length ? 56 : 0,
    summary: picked.length
      ? `（Mock 演示）发现 ${picked.length} 处模板化表达；配置真实模型后会做完整语义诊断。`
      : '（Mock 演示）未发现明显的语义级 AI 腔；配置真实模型后会做完整语义诊断。',
    violations: picked,
  });
}

/** 去AI味补丁修复演示：做最小的模板词删除，返回补丁 JSON */
export function flavorRepairJson(text, issues) {
  const patches = [];
  for (const item of issues || []) {
    const excerpt = String(item.excerpt || '');
    const replacement = demoDeAiText(excerpt);
    if (!replacement || replacement === excerpt) continue;
    patches.push({
      issueId: item.issueId,
      targetExcerpt: excerpt,
      replacement,
      reason: '（Mock 演示）删去模板词，保留原意。',
    });
  }
  return JSON.stringify({
    summary: patches.length ? `（Mock 演示）生成 ${patches.length} 处补丁。` : '（Mock 演示）没有可安全替换的补丁。',
    patches,
  });
}

/* ---------- 章节检查 ---------- */
export function review(c) {
  const seed = seedOf('rv:' + c.id + c.title);
  const score = 76 + (parseInt(seed.slice(0, 2), 16) % 17);
  const obj = {
    score,
    summary: `本章基本完成「${clip(c.title, 10)}」的既定任务，结尾钩子落位；中段节奏略平，环境描写可再压缩，两处对话信息重复。`,
    issues: [
      { severity: 'medium', type: '节奏', location: '中段推进部分', problem: '连续冲突之间缺少喘息点，读者容易疲劳。', suggestion: '在两次交锋之间插入一个静态观察细节，或一段短对话降温。' },
      { severity: 'low', type: '文风', location: '开篇第三段', problem: '形容词略有堆叠，存在一处套路化表达。', suggestion: '删去两处修饰，只保留最具体的那个意象。' },
    ],
  };
  return JSON.stringify(obj, null, 2);
}

/* ---------- 写后整理：摘要 / 角色状态 / 伏笔线索 ---------- */
export function postWrite(p, c, chars, threads) {
  const seed = seedOf('post:' + c.id + c.title);
  const summary = `第${c.idx}章《${clip(c.title, 12)}》中，${clip(c.brief || '主线继续推进', 60)}。关键信息已经露出，人物关系出现新的张力，章末留下待解的问题。`;
  const list = (chars || []).slice(0, 3).map((ch, i) => ({
    name: ch.name,
    status: `第${c.idx}章后：仍在主线现场，知晓了「${clip(c.title, 8)}」的关键信息，与同伴的信任${i === 0 ? '加深' : '出现裂痕'}；${pick(['身上添了新伤', '失去了一件重要东西', '做出了无法回头的选择', '握住了一个新的线索'], seed + i)}。`,
  }));
  const existing = new Set((threads || []).map((t) => t.name));
  const newName = `未解之约·${clip(c.title, 6) || c.idx}`;
  const threadEvents = existing.has(newName)
    ? [{ name: newName, action: 'advance', kind: '悬念', detail: `本章再次被提起，指向更深的一层真相。` }]
    : [
        { name: newName, action: 'new', kind: '悬念', detail: `本章留下的问题：${clip(c.hook || c.brief || '下一步会发生什么', 60)}` },
      ];
  return JSON.stringify({ summary, characters: list, threads: threadEvents }, null, 2);
}

/* ---------- 从正文补录线索 ---------- */
export function extractThreads(c) {
  const seed = seedOf('threads:' + c.id + c.title);
  const list = [
    { name: `旧名单上的名字·${clip(c.title, 6) || c.idx}`, kind: '悬念', detail: `第${c.idx}章出现的关键信息，指向更早的旧案，尚未解释来源。` },
    { name: `${pick(PLACES, seed)}的约定`, kind: '承诺', detail: '人物之间给出一个尚未兑现的承诺，后续需要回应。' },
  ];
  return JSON.stringify(list, null, 2);
}

/* ---------- 拆书分析 ---------- */
export function deconstruct(title, stats) {
  const seed = seedOf('dec:' + title);
  const [a, b, c, v] = pickN(NAMES, seed, 4);
  const obj = {
    summary: `《${title || '参考作品'}》共 ${stats.chapterCount} 章、约 ${stats.totalWords} 字，平均每章 ${stats.avgChapterWords} 字，对话占比 ${stats.dialogueRatio}%。作品以强情节驱动，靠信息差与阶段性目标维持推进。`,
    structure: {
      pattern: '三幕式 + 每卷一个阶段目标',
      beats: [
        '开篇 1-3 章：用一个反常事件打破日常，主角被迫入局',
        '第一次转折：主角获得关键线索，同时付出代价',
        '中点：旧案与主线合流，敌人从暗处走到台前',
        '低谷：最信任的人背叛，主角失去核心资源',
        '高潮：主角用前文埋下的伏笔完成反制',
        '收束：代价被支付，留下一个克制的开放结尾',
      ],
    },
    characters: [
      { name: a, role: '主角', want: '查清真相并夺回自己的名字', flaw: '过度相信证据，不肯相信人', arc: '从旁观者变成当事人' },
      { name: b, role: '伙伴', want: '保住身后的人', flaw: '习惯性隐瞒', arc: '从隐瞒到主动交底' },
      { name: c, role: '对手', want: '用秩序替代真相', flaw: '把所有人都当棋子', arc: '从冷静到失控' },
      { name: v, role: '对手', want: '完成一场被阻止的仪式', flaw: '拒绝承认自己的错误', arc: '从幕后走向台前' },
    ],
    style: {
      pov: '第三人称限制视角，紧贴主角',
      tone: '冷峻、克制，偶尔留一点温度',
      sentence: '短句为主，动作描写干脆，极少长定语',
      dialogue: '对话携带信息差，常用一句反问结束交锋',
      description: '偏好灯光、声音与气味等感官细节，少用视觉形容词堆叠',
      pacing: '每章一个明确目标，章末必留动作或发现作为钩子',
      signature: ['用声音写环境', '用物件承载旧事', '以未完成的动作收尾'],
    },
    techniques: [
      '在开篇 200 字内抛出一个不合常理的具体细节',
      '把设定信息拆进冲突对话，避免整段说明',
      '关键线索先以无用细节出现，回收时读者才反应过来',
      '每次推进都让主角失去一样东西，抬高后续代价',
    ],
    rules: [
      { kind: 'style', name: '开篇即反常', content: '每章前 200 字内出现一个具体、反常的细节，让读者产生疑问。' },
      { kind: 'style', name: '线索前置', content: '关键线索先以看似无关的细节出现，回收时不额外解释。' },
      { kind: 'style', name: '对话带信息差', content: '每段对话至少让一方隐藏一个信息，通过回避或反问体现。' },
      { kind: 'style', name: '动作收尾', content: '章节结尾停在未完成的动作或刚被揭示的物品上，不写总结句。' },
      { kind: 'anti_ai', name: '禁情绪形容词', content: '不写「心中一紧」「瞳孔骤缩」等套话，用身体反应与动作替代。' },
      { kind: 'anti_ai', name: '禁排比抒情', content: '连续三个以上结构相同的句子必须拆开，情绪只在动作中呈现一次。' },
    ],
  };
  return JSON.stringify(obj, null, 2);
}

/* ---------- 连接测试 ---------- */
export function test() {
  return 'Mock 演示模式运行中，无需外部连接。接入真实供应商后可在此测试连通性。';
}
