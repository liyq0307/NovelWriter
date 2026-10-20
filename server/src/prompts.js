/**
 * 提示词库（Prompt Registry）：创作管线每一步的系统与用户提示词。
 * 设计原则：资料分层注入（书级约定 → 世界规则 → 人物状态 → 写法规则 → 章节任务），
 * 便于上游厂商复用稳定前缀（Token 缓存友好）。
 */
import { parseField } from './db.js';
import { clip } from './util.js';

/** 书籍简报：所有提示词共用的头部 */
export function bookBrief(p) {
  const d = parseField(p.direction, null);
  const ct = parseField(p.contract, null);
  const lines = [`书名：《${p.title}》`, `形态：${p.type === 'short' ? '短篇（一次读完、有完整结局）' : '长篇连载'}${d?.genre ? ' · ' + d.genre : ''}`];
  if (d?.logline) lines.push(`一句话故事：${d.logline}`);
  if (d?.protagonist) lines.push(`主角设定：${d.protagonist}`);
  if (ct) {
    const parts = [];
    if (ct.pov) parts.push(`视角=${ct.pov}`);
    if (ct.tone) parts.push(`基调=${ct.tone}`);
    if (ct.arc) parts.push(`故事弧线=${ct.arc}`);
    if (Array.isArray(ct.taboos) && ct.taboos.length) parts.push(`避免=${ct.taboos.join('、')}`);
    if (parts.length) lines.push(`创作约定：${parts.join('；')}`);
  }
  return lines.join('\n');
}

const worldDigest = (entries) => (entries || []).map((w) => `- ${w.name}：${clip(w.content, 100)}`).join('\n');
const charDigest = (chars) => (chars || []).map((c) => `- ${c.name}（${c.role}）：${clip(c.profile, 60)}｜目标：${clip(c.goals, 50)}`).join('\n');

/* ============ 1. 开书方向 ============ */
export function directions(p, guide = {}) {
  const system = '你是资深小说策划编辑，擅长把一句模糊的灵感打磨成可执行的创作方向。只输出 JSON，不要任何解释或多余文字。';
  const lines = [];
  if (guide.genre) lines.push(`题材赛道：${guide.genre}`);
  if (guide.setting) lines.push(`世界观偏好：${guide.setting}`);
  if (guide.references) lines.push(`对标作品：${guide.references}`);
  if (guide.protagonist) lines.push(`主角类型：${guide.protagonist}`);
  if (guide.pov) lines.push(`叙事视角：${guide.pov}`);
  if (guide.tone) lines.push(`情绪基调：${guide.tone}`);
  if (guide.pacing) lines.push(`节奏偏好：${guide.pacing}`);
  if (guide.audience) lines.push(`目标读者：${guide.audience}`);
  if (Array.isArray(guide.sellingPoints) && guide.sellingPoints.length) lines.push(`核心爽点：${guide.sellingPoints.join('、')}`);
  if (guide.mustHave) lines.push(`必须包含：${guide.mustHave}`);
  if (guide.taboos) lines.push(`明确禁忌：${guide.taboos}`);
  const guideBlock = lines.length
    ? `\n【作者补充的创作偏好（必须体现）】\n${lines.join('\n')}\n`
    : '';
  const user = `作者的一句灵感：
"""
${p.premise}
"""
作品形态：${p.type === 'short' ? '短篇（一次读完、有完整结局）' : '长篇连载（可持续推进几十万字）'}${p.target_words ? `，目标约 ${p.target_words} 字` : ''}
${guideBlock}
请基于这句灵感给出 3 个差异明显的候选方向：题材赛道、情绪基调、叙事方式至少各有一项不同；每个方向都要有清晰的读者价值与可执行的故事弧线，主角要有具体的核心欲望与阻力。
作者给出的偏好是硬约束：题材、世界观、主角类型、视角、基调、禁忌必须在候选方向中体现；若与灵感冲突，优先保证灵感的核心冲突成立，再尽量贴合偏好。
每个方向的 contract 必须写实可执行（pov 要具体到人称与视角范围，taboos 要能直接约束正文），不要写空话。

严格输出 JSON 数组：顶层必须是以 [ 开头、] 结尾的数组，包含 3 个元素；不要返回单个对象，不要用 Markdown 代码块包裹。每个元素字段如下：
{"title":"暂定书名","genre":"题材标签","logline":"一句话故事（60字内）","sellingPoints":["卖点","卖点","卖点"],"protagonist":"主角设定（核心欲望与阻力）","style":"文风与叙事基调","audience":"目标读者","contract":{"pov":"叙事视角","tone":"语言基调","taboos":["要避免的写法"],"arc":"整体故事弧线"}}`;
  return { system, user };
}

/* ============ 2. 世界设定 ============ */
export function world(p) {
  const system = '你是小说世界观架构师，擅长搭建自洽、有记忆点、能被正文反复调用的世界设定。只输出 JSON，不要多余文字。';
  const user = `【作品】
${bookBrief(p)}

请起草本书的世界设定条目，覆盖：
- 地理 2-3 条（核心舞台与关键地点，地点本身能制造冲突）
- 势力 2-3 条（组织、立场与资源差异）
- 规则 2-3 条（力量体系/社会规则/核心概念，明确能力边界与代价）
- 物品 1-2 条（可作为线索或麦高芬）
- 历史 1-2 条（埋下可回溯的暗线）

每条设定必须具体可执行、能直接约束正文写作，避免空泛形容词堆砌。

输出 JSON 数组：
[{"category":"地理|势力|规则|物品|历史","name":"条目名","content":"设定内容（80-200字）"}]`;
  return { system, user };
}

/* ============ 3. 角色与关系 ============ */
export function characters(p, entries) {
  const system = '你是小说人物设计师，擅长塑造有欲望、有缺陷、与主线强绑定的人物。只输出 JSON，不要多余文字。';
  const user = `【作品】
${bookBrief(p)}

【已有世界设定】
${worldDigest(entries) || '（暂无，可自行补充必要设定）'}

请设计本书核心人物：主角 1 名、重要配角 2-3 名、反派或对立面 1 名。要求：
- 每个角色有清晰的核心欲望、致命缺陷，以及与故事主线的绑定方式；
- 反派的动机必须逻辑自洽，不能是为反而反；
- 角色之间要形成张力关系网，而非工具人集合。

同时给出他们之间的关系。

输出 JSON 对象：
{"characters":[{"name":"姓名","role":"主角|重要配角|配角|反派","profile":"性格与背景（100字内）","goals":"核心目标与动机","appearance":"外貌特征（50字内）"}],"relations":[{"from":"角色A","to":"角色B","type":"关系类型","description":"一句话说明"}]}`;
  return { system, user };
}

/* ============ 4. 卷纲 ============ */
export function outline(p, entries, chars) {
  const system = '你是小说结构策划，擅长卷级节奏与阶段高潮设计。只输出 JSON，不要多余文字。';
  const body = p.type === 'short'
    ? `本书为短篇，目标约 ${p.target_words || 12000} 字：请规划 3-6 个部分完成「起承转合」，每部分是一个完整的叙事单元。`
    : '本书为长篇连载：请规划前 3-4 卷，每卷是一个有完整弧线的阶段。';
  const user = `【作品】
${bookBrief(p)}

【世界设定】
${worldDigest(entries) || '（暂无）'}

【主要人物】
${charDigest(chars) || '（暂无）'}

${body}
每卷/每部分给出：阶段目标（主角处境如何改变）、主要冲突、结尾钩子。钩子要能自然牵引下一卷/结尾，避免廉价悬念。

输出 JSON 数组：
[{"title":"卷名（长篇含「第X卷·」前缀，短篇用「第X节·」）","summary":"本卷目标、冲突与结尾钩子（120-200字）"}]`;
  return { system, user };
}

/* ============ 5. 拆章 ============ */
export function chapterPlan(p, vol, existingChapters, entries, chars, n) {
  const system = '你是小说责编，擅长把卷纲拆解为可逐章执行的章节任务单。只输出 JSON，不要多余文字。';
  const recent = (existingChapters || []).slice(-6).map((c) => `- 第${c.idx}章《${c.title}》：${clip(c.brief, 60)}`).join('\n');
  const user = `【作品】
${bookBrief(p)}

【本卷】《${vol.title}》
${vol.summary}

【已有章节（避免重复或断裂）】
${recent || '（本卷为全书起始，无已有章节）'}

【世界设定】
${worldDigest(entries) || '（暂无）'}

【人物名单】
${charDigest(chars) || '（暂无）'}

请把本卷拆成 ${n} 章：每章只推进一件事，冲突递进、信息逐步揭示、章章有钩子；场景与出场人物要具体。章节标题不要带序号。

输出 JSON 数组：
[{"title":"章节名（2-6字）","brief":"本章任务：发生什么、推进什么、揭示什么（80字内）","scenes":"场景（地点+事件要点）","cast":["出场人物名"],"hook":"章末钩子（30字内）"}]`;
  return { system, user };
}

/* ============ 6. 章节正文 ============ */
export function chapterWrite(p, c, ctx) {
  const system = `你是一位职业中文小说作者，正在为一部连载作品逐章执笔。写作铁律：
1. 只输出正文本身：不要章节标题、序号、字数说明，不要任何解释性或元信息文字。
2. 严格遵守【写法规则】与【反AI规则】，杜绝AI腔：排比堆叠、空洞抒情、套路化表达。
3. 情节必须完成本章任务，结尾准确落在章末钩子上；不要把钩子写成悬念总结。
4. 叙述与对话交替推进，句子长短错落；用具体动作、感官细节与信息差推动阅读。
5. 人物言行必须符合角色卡与当前状态；能力、情报与世界规则不得越界。
6. 与上一章结尾自然衔接，不重复已写内容，不改写已发生的事实。`;

  const parts = [];
  parts.push('【作品】');
  parts.push(bookBrief(p));
  if (ctx.world?.length) {
    parts.push('\n【世界设定（正文可引用，不得违背）】');
    for (const w of ctx.world) parts.push(`- ${w.name}：${clip(w.content, 120)}`);
  }
  if (ctx.useChars?.length) {
    parts.push('\n【出场人物】');
    for (const ch of ctx.useChars) {
      parts.push(`- ${ch.name}（${ch.role}）：${clip(ch.profile, 80)}｜目标：${clip(ch.goals, 60)}${ch.status ? '｜当前状态：' + clip(ch.status, 80) : ''}`);
    }
  }
  if (ctx.facts?.length) {
    parts.push('\n【已确立的事实（不得违背）】');
    for (const f of ctx.facts) parts.push(`- ${f.kind}${f.subject ? '·' + f.subject : ''}：${clip(f.fact, 90)}`);
  }
  if (ctx.recalls?.length) {
    const kindName = { world: '设定', character: '人物', chapter: '前章', fact: '事实', thread: '线索' };
    const seenTitles = new Set((ctx.world || []).map((w) => w.name));
    const hitLines = ctx.recalls
      .filter((h) => !(h.kind === 'world' && seenTitles.has(h.title.split('·').pop())))
      .map((h) => `- [${kindName[h.kind] || h.kind}] ${h.title}：${clip(h.snippet, 100)}`);
    if (hitLines.length) {
      parts.push('\n【资料检索（与本章相关，可补充细节，不得违背）】');
      parts.push(...hitLines);
    }
  }
  const styleRules = (ctx.rules || []).filter((r) => r.kind === 'style');
  const antiRules = (ctx.rules || []).filter((r) => r.kind === 'anti_ai');
  if (styleRules.length) {
    parts.push('\n【写法规则】');
    for (const r of styleRules) parts.push(`- ${r.name}：${r.content}`);
  }
  if (antiRules.length) {
    parts.push('\n【反AI规则（必须遵守）】');
    for (const r of antiRules) parts.push(`- ${r.name}：${r.content}`);
  }
  if (ctx.flavorWords?.length) {
    parts.push('\n【禁用AI腔表达（生成时就要避开）】');
    for (const r of ctx.flavorWords) parts.push(`- 「${r.phrase}」→ ${r.suggestion || '改写为具体描写'}`);
    parts.push('以上表达不得出现在正文中，用具体动作、感官细节或直接陈述替代。');
  }
  if (ctx.threads?.length) {
    parts.push('\n【伏笔与线索（需承接或回收）】');
    for (const t of ctx.threads.slice(0, 12)) {
      parts.push(`- [${t.status === 'planted' ? '已埋' : '推进中'}] ${t.name}（${t.kind}）：${clip(t.detail, 100)}`);
    }
    parts.push('本章如推进或回收其中线索，必须在正文中给出可被读者感知的动作或信息，不要只在旁白里提一句。');
  }
  if (ctx.summaries?.length) {
    parts.push('\n【前情提要（最近章节，仅供承接，不要复述）】');
    for (const s of ctx.summaries) {
      parts.push(`- 第${s.idx}章《${s.title || '未命名'}》：${clip(s.summary, 160)}`);
    }
  }
  parts.push('\n【上一章结尾】');
  parts.push(ctx.tail ? clip(ctx.tail, 600) : '（本章为开篇，直接进入故事，不要写楔子式说明）');
  parts.push('\n【本章任务】');
  parts.push(`章节名：${c.title || '（未定）'}`);
  if (c.brief) parts.push(`任务：${c.brief}`);
  if (c.scenes) parts.push(`场景：${c.scenes}`);
  if (c.cast?.length) parts.push(`出场人物：${c.cast.join('、')}`);
  if (c.hook) parts.push(`章末钩子：${c.hook}`);
  parts.push(`\n【字数要求】全章约 ${ctx.target} 字，允许上下浮动 15%。`);
  parts.push('\n现在，写出本章正文。');
  return { system, user: parts.join('\n') };
}

/* ============ 7. 续写 ============ */
export function continueWrite(p, c, before, target, ctx = {}) {
  const system = `你是一位职业中文小说作者，正在为已写正文做无缝续写。规则：
1. 只输出从断点继续的新内容，不得重复、概括或改写已有正文；
2. 保持人称、时态、节奏与情绪的连贯；
3. 遵守本书世界规则与人物设定，杜绝AI腔；
4. 只输出正文，不要任何解释或标记。`;
  const threadLine = (ctx.threads || []).slice(0, 6).map((t) => `${t.name}（${t.kind}）`).join('、');
  const flavorLine = (ctx.flavorWords || []).slice(0, 16).map((r) => `「${r.phrase}」`).join('、');
  const user = `【作品】
${bookBrief(p)}

【本章任务】${c.brief || '（未定）'}${c.hook ? `\n【章末钩子】${c.hook}` : ''}
${threadLine ? `\n【可承接的伏笔】${threadLine}` : ''}
${flavorLine ? `\n【禁用AI腔表达（不得出现）】${flavorLine}` : ''}

【已有正文（断点前片段）】
${clip(before, 1200)}

【续写要求】从断点处自然续写约 ${target} 字，推进本章任务，结尾停在一个自然的悬停点。`;
  return { system, user };
}

/* ============ 8. 局部改写 ============ */
export function rewrite(p, selection, instruction, before, after) {
  const system = `你是小说修文师。只输出改写后的完整片段，不要解释、不要任何前后缀或标记。保持与上下文一致的人称、时态与文风；遵循本书写法规则，杜绝AI腔。`;
  const tone = parseField(p.contract, null)?.tone;
  const user = `【作品】《${p.title}》${tone ? ' · 基调：' + tone : ''}

【改写要求】${instruction}

【上下文（片段之前）】
${clip(before, 300)}

【待改写片段】
${clip(selection, 3000)}

【上下文（片段之后）】
${clip(after, 300)}

请输出改写后的完整片段。`;
  return { system, user };
}

/* ============ 8.5 去AI味：单句改写 ============ */
export function flavorRewrite(selection, hits, before, after) {
  const system = `你是中文小说修文师，专门清除「AI 腔」。规则：
1. 只改写给定片段，不改变情节、人物、信息与叙事视角；
2. 删掉或替换命中的 AI 腔词，用具体动作、感官与信息差承载情绪；
3. 句子长短错落，避免排比与万能形容词；
4. 只输出改写后的正文，不要解释、引号、标记或前后缀。`;
  const hitLines = (hits || []).map((h) => `- 「${h.phrase}」：${h.reason || ''}${h.suggestion ? `（建议：${h.suggestion}）` : ''}`).join('\n');
  const user = `【上下文（之前）】
${clip(before, 200) || '（无）'}

【待改写片段】
${clip(selection, 1500)}

【上下文（之后）】
${clip(after, 200) || '（无）'}

【命中的 AI 腔特征】
${hitLines || '（无具体命中，按整体语感去AI化）'}

请只输出改写后的片段。`;
  return { system, user };
}

/* ============ 8.8 按检查结果修文（连写闭环） ============ */
export function revise(p, c, review, ctx = {}) {
  const system = `你是小说修文师，负责按责编意见修改现有章节。规则：
1. 只输出修改后的完整正文，不要解释、不要标注修改处；
2. 保持情节、人物、场景、信息量与章末钩子不变，不得增删事件；
3. 优先解决 high / medium 级问题，逐条落实修改建议；
4. 不得引入新的AI腔，用具体动作与细节替代套话。`;
  const issues = (review?.issues || []).slice(0, 8);
  const parts = [];
  parts.push(`【作品】《${p.title}》`);
  parts.push(`【本章】第${c.idx}章《${c.title || '未命名'}》`);
  if (c.brief) parts.push(`【本章任务】${c.brief}${c.hook ? `\n【章末钩子】${c.hook}` : ''}`);
  if (issues.length) {
    parts.push('\n【检查发现的问题】');
    issues.forEach((it, i) => {
      parts.push(`${i + 1}. [${it.severity}] ${it.type}｜${it.location || '位置未指明'}：${it.problem}${it.suggestion ? `｜建议：${it.suggestion}` : ''}`);
    });
  }
  if (review?.summary) parts.push(`\n【责编总评】${review.summary}`);
  if (ctx.flavorWords?.length) {
    parts.push('\n【禁用AI腔表达】');
    for (const r of ctx.flavorWords.slice(0, 16)) parts.push(`- 「${r.phrase}」→ ${r.suggestion || '改写为具体描写'}`);
  }
  parts.push(`\n【原正文】\n${c.content || ''}`);
  parts.push('\n请输出修改后的完整正文。');
  return { system, user: parts.join('\n') };
}

/* ============ 9. 章节检查 ============ */
export function review(p, c, ctx) {
  const system = '你是严格但讲道理的小说责编，负责章节质检。只输出 JSON，不要多余文字。';
  const parts = [];
  parts.push(`【作品】《${p.title}》`);
  parts.push(`【本章任务】${c.brief || '（未定）'}${c.hook ? `\n【章末钩子】${c.hook}` : ''}`);
  if (ctx.useChars?.length) {
    parts.push('【出场人物与当前状态】');
    for (const ch of ctx.useChars) parts.push(`- ${ch.name}：${clip(ch.status || ch.profile, 80)}`);
  }
  if (ctx.facts?.length) {
    parts.push('\n【已确立的事实（用于核对一致性）】');
    for (const f of ctx.facts.slice(-20)) parts.push(`- ${f.kind}${f.subject ? '·' + f.subject : ''}：${clip(f.fact, 90)}`);
  }
  parts.push(`\n【正文】\n${c.content || ''}`);
  if (ctx.threads?.length) {
    parts.push('\n【进行中的伏笔与线索】');
    for (const t of ctx.threads.slice(0, 10)) parts.push(`- ${t.name}（${t.kind}）：${clip(t.detail, 80)}`);
  }
  parts.push(`\n请从四个维度检查：
1. 任务完成度：是否完成本章任务、钩子是否落位；
2. 一致性：人物言行、世界规则、与前文及【已确立的事实】是否矛盾；
3. 文风：是否存在AI腔、句式单一、形容词堆叠；
4. 节奏与可读性：信息密度、喘息点、钩子力度。

输出 JSON：
{"score":0到100的整数,"summary":"总体评价（80字内）","issues":[{"severity":"high|medium|low","type":"任务|一致|文风|节奏","location":"问题位置","problem":"问题描述","suggestion":"修改建议"}]}
没有问题的维度不要硬凑问题；整体合格时 issues 可以为空数组。`);
  return { system, user: parts.join('\n') };
}

/* ============ 10. 写后整理：章节摘要 + 角色状态 + 伏笔线索 + 既定事实 ============ */
/**
 * 一次调用完成四件事，减少连续创作中的重复消耗：
 * - 本章摘要：成为后续章节的长期记忆
 * - 角色状态：位置、处境、掌握信息、关系变化
 * - 伏笔线索：新埋、推进、回收、放弃
 * - 既定事实：死亡/受伤/得失/抵达等硬事实，后续生成不得违背
 */
export function postWrite(p, c, chars, threads, facts = []) {
  const system = '你是小说连载的资料管理员，负责在每章写完后整理可被后续章节直接引用的记忆。只输出 JSON，不要任何解释或多余文字。';
  const charList = (chars || []).map((ch) => `- ${ch.name}（${ch.role}）：${ch.status || '（暂无记录）'}`).join('\n');
  const threadList = (threads || []).length
    ? (threads || []).map((t) => `- ${t.name}（${t.kind}，${t.status}）：${t.detail || '（暂无说明）'}`).join('\n')
    : '（暂无进行中的伏笔）';
  const factList = (facts || []).length
    ? (facts || []).map((f) => `- ${f.fact}`).join('\n')
    : '（暂无）';
  const user = `【作品】《${p.title}》
【本章】第${c.idx}章《${c.title || '未命名'}》
【本章任务】${clip(c.brief, 200) || '（未定）'}

【角色与当前状态】
${charList || '（无角色）'}

【进行中的伏笔与线索】
${threadList}

【已有事实（不要重复记录）】
${factList}

【本章正文】
${clip(c.content, 6000)}

请完成四件事：
1. 本章摘要：80-120 字，只记录已经发生的事实（谁做了什么、得到/失去了什么、留下什么悬念），供后续章节回顾，不评价文笔。
2. 角色最新状态：只列本章确实受影响的角色；状态写成可被后续章节直接引用的事实（位置、处境、掌握信息、关系变化、伤势等），80 字内。
3. 伏笔与线索：new=本章新埋下的，advance=本章推进的，resolve=本章已回收的，drop=本章明确放弃的。已有线索必须沿用原名；没有变化就输出空数组。
4. 既定事实：只记录本章明确发生、且会影响后续章节的硬事实（死亡、受伤、获得/失去物品、抵达/离开、关系确立、规则生效、关键信息揭示等），一条一句，不写情绪与推测；已在【已有事实】中的不要重复。

输出 JSON：
{"summary":"本章摘要","characters":[{"name":"角色名","status":"最新状态"}],"threads":[{"name":"线索名","action":"new|advance|resolve|drop","kind":"伏笔|线索|悬念|承诺","detail":"一句话说明"}],"facts":[{"kind":"世界规则|时间线|人物|剧情","subject":"主体","fact":"一句话事实"}]}`;
  return { system, user };
}

/* ============ 11. 从正文补录伏笔线索 ============ */
export function extractThreads(c, existingNames) {
  const system = '你是小说责编，擅长从正文中识别伏笔、线索、悬念与承诺。只输出 JSON 数组，不要任何解释。';
  const user = `【已有线索（不要重复）】
${(existingNames || []).length ? existingNames.map((n) => `- ${n}`).join('\n') : '（暂无）'}

【本章正文】
${clip(c.content, 6000)}

请找出本章真正埋下、但尚未回收的伏笔 / 线索 / 悬念 / 承诺。只输出确实会影响后续情节的条目，不要把普通情节当伏笔。
每条给出：名称（可复用、具体）、类型、埋设位置与指向。

输出 JSON 数组：
[{"name":"线索名","kind":"伏笔|线索|悬念|承诺","detail":"埋在哪里、指向什么"}]`;
  return { system, user };
}

/* ============ 12. 拆书分析 ============ */
export function deconstruct(title, stats, digest) {
  const system = `你是资深网文编辑兼拆书教练，擅长从一部成熟作品里提炼可复用的结构与写法。只输出 JSON，不要任何解释或多余文字。
分析原则：
1. 结论必须由给定文本支撑，不要套用通用模板；
2. 写法的描述要具体到「怎么做」，而不是「文笔好」这类空话；
3. 提炼的规则要能直接注入写作提示词使用。`;
  const statLines = [
    `总字数：${stats.totalWords}`,
    `章节数：${stats.chapterCount}`,
    `平均每章：${stats.avgChapterWords} 字`,
    `对话占比：${stats.dialogueRatio}%`,
    `平均句长：${stats.avgSentence} 字`,
    `平均段长：${stats.avgParagraph} 字`,
    `人称判断：${stats.povGuess}`,
  ].join('\n');
  const user = `【参考作品】《${title || '未命名参考作品'}》

【文本统计】
${statLines}

【结构采样】
${digest}

请完成一次完整的拆书，输出 JSON 对象：
{
  "summary":"作品梗概与核心卖点（150字内）",
  "structure":{"pattern":"整体结构模型（如三幕式/英雄之旅/双线交汇/单元剧）","beats":["关键情节点 1（含大致章节位置）","关键情节点 2","……"]},
  "characters":[{"name":"角色名","role":"主角|对手|伙伴|导师","want":"核心欲望","flaw":"致命缺陷","arc":"弧线变化"}],
  "style":{"pov":"叙事视角","tone":"语言基调","sentence":"句式特征","dialogue":"对话写法","description":"描写偏好","pacing":"节奏控制","signature":["可识别的标志性写法"]},
  "techniques":["可复用的具体技巧 1","技巧 2","……"],
  "rules":[{"kind":"style|anti_ai","name":"规则名（8字内）","content":"可直接写入写作提示词的规则（60字内）"}]
}
要求：characters 3-6 个，beats 4-8 条，techniques 3-6 条，rules 4-8 条。`;
  return { system, user };
}
