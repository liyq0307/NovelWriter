/**
 * 示例作品：一键写入一本可直接体验的完整书。
 * 内容为静态示例，不调用任何模型；覆盖世界、角色、卷纲、拆章、正文、
 * 摘要、伏笔、版本历史、码字统计与用量记录，方便第一次打开就能看到完整形态。
 */
import { get, run, now } from './db.js';
import { countWords } from './util.js';

const DEMO_TITLE = '灯下黑（示例）';

const PREMISE = '一个能听见死者执念的点灯人，在戒严的城市里追查三十年前全城灯火熄灭之谜';

const CONTRACT = {
  pov: '第三人称限知，主视角林渡；关键章节切入温小满',
  tone: '冷、旧、克制；少用形容词堆叠，多用动作、气味与旧物细节',
  taboos: ['不写现代科技', '不靠系统金手指', '不用“他知道，一切都才刚刚开始”式结尾'],
  arc: '从“听见死者”到“替死者把话说完”，林渡最终选择成为守灯人',
};

const DIRECTION = {
  title: '灯下黑',
  genre: '东方奇幻 · 悬疑',
  logline: '全城的灯都熄过一夜，只有点灯人记得那一夜的名字。',
  sellingPoints: [
    '能听见死者执念的点灯人，追查三十年前全城灯火熄灭之谜',
    '以灯为誓的戒严之城，每一盏灯下都埋着一个名字',
    '不是升级打怪，而是一层层剥开“谁在说谎”的旧案',
  ],
  protagonist: '林渡',
  style: '冷峻克制，重感官与旧物细节；对话短，留白多',
  audience: '喜欢城市悬疑与东方奇幻的读者',
  contract: CONTRACT,
};

const WORLD = [
  {
    category: '地理',
    name: '临渊城',
    content: '依山而建的旧城，分上城、下城与灯楼三层。三更后全城熄灯，唯灯楼长明。城南多青石巷与旧井，城北是守夜人司与封巷。',
  },
  {
    category: '势力',
    name: '守夜人司',
    content: '掌灯律、巡夜与封巷。司主之下设提灯校尉、书吏、熄灯人。表面维护宵禁，实则看守灯楼地底的旧封印。',
  },
  {
    category: '规则',
    name: '灯誓',
    content: '点灯人入门时以血立誓：灯以照夜，亦以照心。违誓者，灯焰会记住他的名字。灯誓原文的后半段在三十年前被撕去。',
  },
  {
    category: '物品',
    name: '铜骨灯',
    content: '以铜为骨、以人骨为芯的旧灯。能存死者最后一句话，点灯人贴耳可听见。灯籍上每死一个点灯人，灯楼地底就多一盏铜灯。',
  },
  {
    category: '历史',
    name: '三十年前的长夜',
    content: '全城灯火在同一夜熄灭，官方称灯油掺水。灯籍上死了一百二十七人，活下来的只有三个。那一夜之后，封巷的铜牌上多了一只闭着的眼。',
  },
];

const CHARACTERS = [
  {
    name: '林渡',
    role: '主角',
    profile: '城南点灯人，二十三岁，能听见铜灯里死者的执念。左手虎口有一道被灯油烫出的旧疤。',
    goals: '查清三十年前的灯籍上为什么有自己的名字，活过下一次长夜。',
    appearance: '瘦，旧青布衣，提一盏磕掉漆的铜灯。',
    status: '第3章后：在灯楼地底问灯，看见三十年前的自己；被陆惊鸿怀疑“不是林渡”。',
  },
  {
    name: '温小满',
    role: '重要配角',
    profile: '守夜人司书吏，记性好，擅长从废档里拼出旧案。母亲是三十年前最后一任守灯人，失踪于长夜。',
    goals: '找回母亲失踪的真相，保住甲七灯籍。',
    appearance: '青灰书吏袍，素木簪，袖口常年沾墨。',
    status: '第3章后：把灯誓残卷交给林渡，开始赌上自己的前程。',
  },
  {
    name: '陆惊鸿',
    role: '重要配角',
    profile: '守夜人司提灯校尉，刀不出鞘，出手极快。右肩有一道三十年前的灯火烧伤，阴天会疼。',
    goals: '守住灯律，也守住地底那个秘密。',
    appearance: '黑衣，短刀无鞘，右肩比左肩低半寸。',
    status: '第3章后：尾随林渡进入地底石室，刀尖最终对准了司主。',
  },
  {
    name: '阿禾',
    role: '配角',
    profile: '灯楼哑女，能看见灯焰里的记忆。喉咙上的疤是幼年触犯灯誓留下的，从此不能说话。',
    goals: '守住灯楼，也守住林渡。',
    appearance: '灰衣，赤脚，手腕系一圈旧铜铃。',
    status: '第3章后：以指尖血为林渡问灯，灯灭后昏迷。',
  },
];

const RELATIONS = [
  { from_name: '林渡', to_name: '温小满', type: '互相试探', description: '旧案里认识，彼此都藏着没说完的话。' },
  { from_name: '林渡', to_name: '陆惊鸿', type: '亦敌亦友', description: '一个要查真相，一个要守规矩。' },
  { from_name: '阿禾', to_name: '林渡', type: '守护', description: '她最早在灯里看见他的结局。' },
  { from_name: '温小满', to_name: '陆惊鸿', type: '上下级', description: '书吏与校尉，表面公事公办，私下互相递过消息。' },
];

const VOLUMES = [
  {
    title: '第一卷·灯下黑',
    summary: '林渡在宵禁夜捡到一盏不该亮起的铜灯，被卷进三十年前的旧案。他进入灯楼地底，第一次问灯，看见全城熄灯的那一夜。',
  },
  {
    title: '第二卷·满城灯',
    summary: '灯会重启，满城灯火在同一刻转向地底。林渡与温小满下到旧城，发现临渊城下面还有一座临渊城。',
  },
  {
    title: '第三卷·守夜人',
    summary: '封印将破，守夜人司的旧誓被补全。林渡必须决定：让谁留在灯里，让谁在灯外活下去。',
  },
];

const CHAPTERS = [
  {
    v: 0, title: '灯灭之夜', cast: ['林渡', '陆惊鸿', '阿禾'],
    brief: '三更熄灯，林渡在土地庙前的灯里听见“沈照”，循着违禁的灯火进入封巷，发现一具旧袍男尸与三十年前的灯籍。',
    scenes: '宵禁长街 / 土地庙 / 封巷井边',
    hook: '灯籍末行写着林渡的名字，而三十年前他还没有出生。',
  },
  {
    v: 0, title: '旧名单', cast: ['林渡', '温小满', '陆惊鸿', '阿禾'],
    brief: '守夜人司审讯，温小满暗中递线索；阿禾带林渡进入灯楼地底，看见满墙刻名铜灯。',
    scenes: '审讯室 / 西门灯柱 / 灯楼地底石室',
    hook: '刻着“林渡”的铜灯里，传出他自己的声音：“如果你听见了，说明我又失败了。”',
  },
  {
    v: 0, title: '灯焰里的眼睛', cast: ['林渡', '温小满', '陆惊鸿', '阿禾'],
    brief: '三人第一次问灯，看见三十年前守夜人亲手熄灯；司主出现在石室入口。',
    scenes: '地底石室 / 问灯幻境 / 三十年前的长街',
    hook: '幻境里站着和林渡同一张脸的人，司主问：“问出什么了？”',
  },
  {
    v: 0, title: '借火', cast: ['林渡', '陆惊鸿'],
    brief: '林渡被要求为守夜人司点一盏借命灯，灯油是死者的记忆。',
    scenes: '灯楼顶层 / 借命灯室',
    hook: '灯亮后，温小满叫出了一个不该属于林渡的旧名。',
  },
  {
    v: 0, title: '满城灯', cast: ['林渡', '温小满', '阿禾'],
    brief: '灯会重启，满城灯火在同一刻转向地底。',
    scenes: '上城灯街 / 灯楼广场',
    hook: '灯会不是庆典，是封印的校准。',
  },
  {
    v: 0, title: '灯下黑', cast: ['林渡', '陆惊鸿', '阿禾'],
    brief: '陆惊鸿奉命抓捕林渡，阿禾以灯焰为代价打开地道。',
    scenes: '封巷 / 灯楼地底 / 旧水道',
    hook: '地底传来第二座城的钟声。',
  },
  {
    v: 1, title: '地下城', cast: ['林渡', '温小满'],
    brief: '林渡与温小满下到旧城，发现地底还有一座临渊城。',
    scenes: '旧水道 / 地下长街 / 倒悬的灯楼',
    hook: '旧城的路牌上写着“临渊”。',
  },
  {
    v: 1, title: '守夜人', cast: ['林渡', '陆惊鸿', '温小满'],
    brief: '守夜人司的成立真相浮出水面，第一任司主竟是林渡的师父。',
    scenes: '地下司署 / 旧档库',
    hook: '第一任司主的画像上，落款是林渡的名字。',
  },
  {
    v: 1, title: '借来的名字', cast: ['林渡', '温小满'],
    brief: '林渡追查自己名字的来源，发现死者并没有真正死去。',
    scenes: '灯籍库 / 地下长街',
    hook: '三十年前的死者只是被灯记住了，身体还在城里走动。',
  },
  {
    v: 1, title: '灯油', cast: ['林渡', '温小满', '阿禾'],
    brief: '灯油的来源被揭开，温小满的母亲仍在灯里。',
    scenes: '灯楼油库 / 地底灯海',
    hook: '灯油不是油，是有人自愿留下的记忆。',
  },
  {
    v: 1, title: '长夜', cast: ['林渡', '陆惊鸿', '温小满'],
    brief: '封印松动，城中出现没有影子的人。',
    scenes: '上城长街 / 守夜人司',
    hook: '陆惊鸿的影子先消失了。',
  },
  {
    v: 1, title: '第二座城', cast: ['林渡', '温小满', '陆惊鸿', '阿禾'],
    brief: '地上城与地下城在灯焰里重叠，两座城的灯同时亮起。',
    scenes: '灯楼顶 / 地下灯楼 / 重叠的长街',
    hook: '两座城的灯同时亮起，照出同一个司主。',
  },
  {
    v: 2, title: '守灯人', cast: ['林渡', '阿禾'],
    brief: '林渡决定成为新的守灯人，代价是亲手熄掉自己最爱的那盏灯。',
    scenes: '灯楼顶层 / 长明灯室',
    hook: '守灯人第一课：先学会熄灯。',
  },
  {
    v: 2, title: '旧誓', cast: ['林渡', '温小满'],
    brief: '灯誓的原文被补全，最后一句是“灯灭人存”。',
    scenes: '旧档库 / 灯誓碑',
    hook: '誓言的最后一句，是让守灯人去死。',
  },
  {
    v: 2, title: '温小满', cast: ['林渡', '温小满', '陆惊鸿'],
    brief: '温小满选择进入灯里换回母亲，只留下一封没有寄出的信。',
    scenes: '地底灯海 / 灯楼长明灯室',
    hook: '信上只有一句：别把我写进灯籍。',
  },
  {
    v: 2, title: '陆惊鸿', cast: ['林渡', '陆惊鸿'],
    brief: '陆惊鸿的真实身份揭开：他是三十年前活下来的守灯人。',
    scenes: '封巷 / 三十年前的灯楼',
    hook: '他一直在等林渡长大。',
  },
  {
    v: 2, title: '长夜将尽', cast: ['林渡', '陆惊鸿', '阿禾'],
    brief: '最终封印仪式开始，需要一盏永远不灭的灯。',
    scenes: '灯楼顶 / 地底封印',
    hook: '永远不灭的灯，需要一个人永远留在里面。',
  },
  {
    v: 2, title: '灯下黑', cast: ['林渡', '阿禾'],
    brief: '林渡留在灯里，阿禾成为新的点灯人。很多年后，有人在灯里听见他的名字。',
    scenes: '灯楼 / 长街 / 很多年后的临渊城',
    hook: '新来的点灯人贴耳听见灯里说：别让最后一盏灯灭。',
  },
];

const CH1 = `临渊城的夜不是黑的。

灯楼上的火舌被风压得低低的，像一只伏在铜罩里喘息的眼睛。每到三更，守夜人司的铜锣沿街敲过三遍，全城的灯就得熄——只留下灯楼最高处那一盏，照着城墙上巡夜人的枪尖。

林渡是城南的点灯人。他提着一盏旧铜灯，沿青石巷一盏一盏地熄过去。灯芯浸了潮，熄的时候会“嗤”地吐一口白烟，像人在临死前松开最后一口气。

他听得见那口气里的东西。

孤儿院的老嬷嬷说过，林渡生下来不哭，直到接生婆把灯凑近，他才睁眼，冲着火苗笑。后来城里人都说，点灯人林渡能听见死者的执念。他不承认，也不否认。每次熄灯，他只是把耳朵贴近铜罩，听一会儿，然后继续走。

今晚第一盏灯里，是个男人的声音，反反复复只有一句：账还没还。第二盏灯里，是个孩子在数数，数到七就哭。第三盏灯在土地庙前，灯罩裂了一道缝，火苗歪着烧。林渡伸手去拧灯芯，指尖刚碰到铜壁，整个人就僵住了。

那是个女人的声音，很轻，像隔着一层水。

“沈照。”

林渡不认识这个名字。可那声音又响了一遍，带着一种近乎固执的温柔：“沈照，别让他们把灯点起来。”

风从巷口灌进来，火苗猛地一跳，灭了。林渡站在原地，听见自己的心跳一下一下撞着肋骨。他抬头，看见巷子深处亮着一盏灯。

那盏灯不该亮。那条巷子三十年前就封了，巷口钉着守夜人司的铜牌，牌上刻着一只闭着的眼。可此刻，巷子深处有一团暖黄的光，稳稳地亮着，像有人在里面等人。

林渡应该走。三更过后还亮着的灯，按《灯律》要罚三十鞭；私入封巷，罚五十。可他听见那声音又在灯里说了一遍：“沈照。”

他提起自己的铜灯，推开了巷口的木栅。

巷子比外面冷。两侧的门都钉死了，门缝里长出黑色的苔。那盏灯在一口井边，是一盏很旧的铜灯，灯身上刻着缠枝莲，底座却被人用刀刮花了。灯旁躺着一个人。

是个男人，穿着守夜人司的旧式黑袍，脸朝下，一只手伸向灯，另一只手死死攥着什么。林渡蹲下去，把他的手掰开。掌心里是一页发黄的纸，纸边被血浸透了。

纸上是一份灯籍。三十年前，临渊城所有点灯人的名字都在上面。每一个名字后面，都画着一盏熄掉的灯。

最下面一行，写着“林渡”。

林渡盯着那两个字，觉得后颈的汗毛一根根立起来。他今年二十三。三十年前，他还没有出生。

巷口传来脚步声。很多人，靴底踩着湿石板，整齐得像一排钉子。灯火从巷外照进来，把林渡的影子拉得很长。他听见一个年轻男人的声音，冷得像刀背：“谁在里面？”

林渡把纸塞进袖子里，站起身。来人穿着守夜人司的提灯校尉服，腰上挂着一柄没有鞘的短刀。他看了林渡一眼，又看了看地上的尸体，眉头慢慢皱起来。他抬手时，右肩比左肩低半寸，像那里压着什么旧东西。

“林渡。”他叫出他的名字，“你知不知道，你手里那盏灯，三十年前就该灭了？”

林渡低头。他这才发现，自己提来的那盏旧铜灯，不知什么时候亮了。火苗是青白色的，没有一点温度。灯罩上，映出一只睁开的眼睛。

巷子尽头，一个穿灰衣的哑女站在阴影里，冲他比了一个手势。

“灯里有名字。”`;

const CH2 = `守夜人司的审讯室没有窗，墙上只嵌着一盏长明灯。灯油里掺了醒神草，烧起来有一股苦味。林渡被按在铁椅里，手腕上的铜铐越挣越紧，勒出一道红痕。

陆惊鸿坐在他对面，把那页血纸摊在桌上，用刀尖压着。

“三十年前的灯籍，编号甲七，全城点灯人一百二十七名。”他抬起眼，“那一夜之后，活下来的只有三个。你猜，这三个名字里为什么没有你？”

“因为我没有出生。”林渡说。

陆惊鸿笑了一下，笑意没到眼底。“我也希望是这样。可灯籍不会写活人的名字，除非那个人在灯里死过一次。”

他抬手按住桌沿，右肩的旧伤在灯下泛出一道白痕，很快又隐进衣料里。

门被推开。一个穿青灰书吏袍的年轻女人抱着一摞卷宗走进来，头发用一支素木簪挽着，袖口沾着墨。她把卷宗放在桌上，先看了林渡一眼，才对陆惊鸿说：“校尉，司主让你别动刑。”

“温小满，这里没你的事。”

“灯籍归我管。”温小满把最上面一卷抽出来，翻到最后一页，“甲七灯籍的副本，三十年前就烧了。这一页是从灯楼地底的废档里找出来的。纸是新的，墨是旧的。”

陆惊鸿的刀尖顿了一下。

林渡看着温小满。她的手指很稳，翻页的时候却有意无意地把一张折好的纸片推到了他手边。纸片很小，上面只有一个字：等。

审讯到后半夜，陆惊鸿被司主叫走。温小满收起卷宗，经过林渡身边时低声说：“西门，第三个灯柱。阿禾在等你。”

林渡从守夜人司后墙翻出去时，天边已经泛灰。西门的灯柱下，阿禾蹲在阴影里，怀里抱着一盏没有点燃的灯。她看见他，站起来，把灯递给他，又指了指自己的喉咙。那里有一道旧疤，像一条细细的灯芯。

她带着他绕过巡夜的岗哨，钻进灯楼后面的排水渠。水很浅，底下铺着碎瓷。走了大约一炷香，前面的墙忽然空了。阿禾推开一块松动的砖，露出一道向下的石阶。

石阶尽头是一间圆形的石室。林渡举灯照过去，呼吸停了一瞬。

石室的墙上，嵌满了铜灯。密密麻麻，一层一层，从地面一直排到穹顶。每一盏灯下都刻着一个名字，名字后面是一道熄灭的刻痕。林渡看见了灯籍上的那些名字：周阿大、陈四娘、许百川……最后一行，刻着“林渡”。

那盏灯是亮着的。

不，不是亮。灯芯没有火，可铜罩里有一点极淡的青光，像一只闭着的眼。林渡伸手去碰，指尖刚触到铜壁，石室里所有的灯同时轻轻震了一下。

他听见自己的声音，从灯里传出来。

那声音比他现在更低沉，带着三十年前的疲惫，只说了一句话：

“如果你听见了，说明我又失败了。”

阿禾猛地拉住他的袖子。林渡回头，看见石室入口的阴影里站着一个人。陆惊鸿不知道什么时候跟了下来，手按在刀柄上，脸色比墙上的铜灯还冷。

“原来司主说得对。”他说，“你不是林渡。”`;

const CH3 = `石室里静得能听见灯油凝固的声音。

陆惊鸿的刀没有出鞘。他只是站在那里，看着林渡，像在看一件不该出现在这里的旧物。阿禾挡在林渡身前，双手飞快地比划。陆惊鸿皱起眉：“她说灯认了你。”

“灯籍也认了我。”林渡把袖子里的血纸拿出来，“你们到底在怕什么？”

陆惊鸿沉默了很久，久到墙上的铜灯又轻轻震了一次。他终于开口：“三十年前，临渊城所有的灯在同一夜熄灭。守夜人司对外说，是灯油掺了水。只有司主知道，那一夜是我们自己熄的。”

“为什么？”

“为了封住地底的东西。”陆惊鸿抬头看向穹顶，“这座城不是建在地上的。它建在一盏灯上。灯楼是灯芯，满城的灯是灯罩。灯亮着，地底的东西就醒不过来。”

温小满从石阶上走下来，手里提着一只小铜匣。她看了陆惊鸿一眼，像是在确认什么，然后打开匣子，里面是一卷薄薄的灯誓。

“灯誓的原文只剩前半段。”她说，“后半段被人撕了。但我比对过三十年前的灯籍，缺的那一页，正好是问灯的仪轨。”

林渡接过灯誓。纸上的字很旧，墨色却像刚干。第一句是：灯以照夜，亦以照心。

“问灯要三样东西。”温小满说，“一盏记得名字的灯，一个听得见执念的人，还有一滴灯油。”

阿禾伸出手。她的小指上有一道旧伤，像是被火燎过。林渡忽然明白了她喉咙上的疤。他摇头：“不行。”

阿禾没有理他。她把手指按在刻着“林渡”的铜灯上，灯罩里那点青光忽然涨大，像一朵没有温度的火。灯焰亮起的一瞬，陆惊鸿的右肩猛地一抽，像被一根看不见的针扎了一下。他上前一步，想拦，最终却没有动。

“问灯一旦开始，就不能停。”他说，“你听见的，未必是你想听的。”

林渡把手掌贴在灯上。

世界暗了一瞬。

他站在一条他从未见过的长街上。街两侧挂满了灯，每一盏都亮着，亮得刺眼。街上站满了人，穿着三十年前的旧衣，仰头看着灯楼。灯楼上站着一个穿黑袍的人，正举着一盏铜灯，往灯芯上浇什么东西。

“熄灯——”那人喊。

满城的灯一盏接一盏地灭下去。人群没有惊慌，也没有声音。他们只是站着，像一排排被抽走了影子的木偶。灯灭到林渡面前时，他看见灯罩上映出一张脸。

那是他自己的脸。

不，比他更老。眼角有细纹，鬓边有一缕白。那人也看见了他，隔着三十年的黑暗，冲他极轻地摇了一下头。

“别让他们点灯。”那人说。

阿禾的手从他肩上穿过，像穿过一层水。林渡猛地回神，石室里的灯全灭了。只有刻着他名字的那一盏还亮着，青光里浮出一行新的字。

“灯下黑，人上人。”

陆惊鸿拔出了刀。刀尖没有对准林渡，而是对准了石室入口。那里站着一个人，穿着守夜人司司主的黑氅，脸藏在灯影里。

“问灯问出什么了？”司主问。

林渡看着他，听见自己心里有一个很轻的声音回答：

“问出了，谁在说谎。”`;

const CHAPTER_TEXT = { 1: CH1, 2: CH2, 3: CH3 };

const CHAPTER_SUMMARY = {
  1: '三更熄灯时，林渡在土地庙前的灯里听见一个女人反复念着“沈照”。他循着不该亮起的灯进入封巷，发现一名穿守夜人司旧袍的男子死在一盏旧铜灯旁，手里攥着三十年前的灯籍，末行写着林渡的名字。提灯校尉陆惊鸿赶到，林渡提着的灯自行亮起；哑女阿禾在巷尾比出“灯里有名字”。',
  2: '守夜人司审讯中，陆惊鸿认定林渡与三十年前的灯籍有关；书吏温小满暗中留给他一张“等”的纸条，并指引他去西门找阿禾。阿禾带林渡从排水渠进入灯楼地底石室，墙上嵌满刻着名字的铜灯，其中刻着“林渡”的灯里传出他自己的声音。陆惊鸿尾随而至，说“你不是林渡”。',
  3: '林渡从陆惊鸿口中得知，三十年前全城熄灯是守夜人司自己所为，为封住地底的东西。温小满带来灯誓残卷，阿禾以指尖血为引，三人第一次问灯。林渡在幻境中看见三十年前的熄灯夜，也看见一张和自己相同的脸。灯灭后，司主出现在石室入口，陆惊鸿的刀尖转向了他。',
};

const REVIEW_1 = {
  score: 88,
  summary: '开篇冲突明确，灯与执念的设定落地，封巷发现尸体的钩子有效。中段环境描写略密，进入封巷可以再快一点。',
  issues: [
    {
      severity: 'low',
      type: '节奏',
      location: '第二段至第四段',
      problem: '连续几段都在写熄灯与声音，进入封巷稍慢。',
      suggestion: '保留土地庙的异常，删去一盏普通灯的细节。',
    },
    {
      severity: 'low',
      type: '文风',
      location: '陆惊鸿出场',
      problem: '“冷得像刀背”与后文“没有鞘的短刀”意象重复。',
      suggestion: '二选一，保留短刀，把声音改成脚步声。',
    },
  ],
};

const THREADS = [
  {
    name: '铜灯里的名字',
    kind: '悬念',
    status: 'reinforced',
    detail: '三十年前的灯籍末行写着林渡的名字，灯楼地底刻着“林渡”的铜灯里传出他自己的声音：“如果你听见了，说明我又失败了。”',
    planted_chapter: 1,
    last_chapter: 3,
  },
  {
    name: '沈照',
    kind: '线索',
    status: 'planted',
    detail: '土地庙前的灯里，一个女人的声音反复念着“沈照”，并说“别让他们把灯点起来”。这个名字尚未在现有灯籍中出现。',
    planted_chapter: 1,
    last_chapter: 1,
  },
  {
    name: '地底的无名灯',
    kind: '伏笔',
    status: 'reinforced',
    detail: '石室墙上有一盏没有名字、只刻着一只眼睛的铜灯。所有灯震动时，只有它没有动；灯灭后，它仍留着一线青光。',
    planted_chapter: 2,
    last_chapter: 3,
  },
  {
    name: '温小满的信',
    kind: '承诺',
    status: 'planted',
    detail: '温小满在灯誓残卷里夹了一张没有寄出的信笺，收信人一栏写着“沈照”。她还没有解释这张纸的来历。',
    planted_chapter: 3,
    last_chapter: 3,
  },
  {
    name: '陆惊鸿的旧伤',
    kind: '伏笔',
    status: 'resolved',
    detail: '陆惊鸿右肩有三十年前的灯火烧伤。问灯时旧伤随灯焰发亮，说明他亲历过那一夜；但他为何活下来、又为何守口如瓶，仍未解开。',
    planted_chapter: 2,
    last_chapter: 3,
  },
];

const CH1_DRAFT = `临渊城的灯，是在三更熄的。

林渡不喜欢三更。铜锣一响，整条长街的灯就要一盏盏灭下去，像有人把一座城的呼吸按住了。他提着旧铜灯从城南走到城北，灯芯浸了潮，熄的时候会吐出一口白烟。

他听得见白烟里的声音。

今晚第一盏灯里，是个男人的声音，反反复复只有一句：账还没还。第二盏灯里，是个孩子在数数，数到七就哭。第三盏灯在土地庙前，灯罩裂了一道缝，火苗歪着烧。林渡伸手去拧灯芯，指尖刚碰到铜壁，整个人就僵住了。

那是个女人的声音，很轻，像隔着一层水。

“沈照。”

林渡不认识这个名字。可那声音又响了一遍，带着一种近乎固执的温柔：“沈照，别让他们把灯点起来。”

风从巷口灌进来，火苗猛地一跳，灭了。林渡站在原地，听见自己的心跳一下一下撞着肋骨。他抬头，看见巷子深处亮着一盏灯。

那盏灯不该亮。那条巷子三十年前就封了，巷口钉着守夜人司的铜牌，牌上刻着一只闭着的眼。可此刻，巷子深处有一团暖黄的光，稳稳地亮着。

林渡提起自己的铜灯，推开了巷口的木栅。`;

function isoDaysAgo(days, hour = 21, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function dayKeyOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function findDemoProject() {
  return get('SELECT * FROM projects WHERE title = ? ORDER BY id DESC LIMIT 1', DEMO_TITLE);
}

export function seedDemo() {
  const existing = findDemoProject();
  if (existing) return { created: false, project: existing };

  const t = isoDaysAgo(6, 20, 10);
  const info = run(
    `INSERT INTO projects (title, type, status, premise, direction, contract, target_words, sync_state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    DEMO_TITLE,
    'novel',
    'writing',
    PREMISE,
    JSON.stringify(DIRECTION),
    JSON.stringify(CONTRACT),
    0,
    1,
    t,
    now()
  );
  const projectId = Number(info.lastInsertRowid);

  for (const w of WORLD) {
    run(
      'INSERT INTO world_entries (project_id, category, name, content, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      projectId, w.category, w.name, w.content, 'ai', t, now()
    );
  }

  for (const c of CHARACTERS) {
    run(
      'INSERT INTO characters (project_id, name, role, profile, goals, appearance, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      projectId, c.name, c.role, c.profile, c.goals, c.appearance, c.status, t, now()
    );
  }

  for (const r of RELATIONS) {
    run(
      'INSERT INTO relations (project_id, from_name, to_name, type, description) VALUES (?,?,?,?,?)',
      projectId, r.from_name, r.to_name, r.type, r.description
    );
  }

  const volumeIds = [];
  VOLUMES.forEach((v, i) => {
    const vi = run(
      'INSERT INTO volumes (project_id, idx, title, summary, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      projectId, i + 1, v.title, v.summary, t, now()
    );
    volumeIds.push(Number(vi.lastInsertRowid));
  });

  const chapterIds = new Map();
  CHAPTERS.forEach((c, i) => {
    const idx = i + 1;
    const text = CHAPTER_TEXT[idx] || '';
    const wc = countWords(text);
    const status = idx === 1 || idx === 2 ? 'done' : idx === 3 ? 'draft' : 'planned';
    const createdAt = isoDaysAgo(Math.max(1, 5 - Math.min(idx, 4)), 20, 30);
    const updatedAt = idx <= 3 ? isoDaysAgo(3 - idx, 22, 15) : createdAt;
    const ci = run(
      `INSERT INTO chapters
       (project_id, volume_id, idx, title, brief, scenes, cast_names, hook, status, content, summary, review, word_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      projectId,
      volumeIds[c.v],
      idx,
      c.title,
      c.brief,
      c.scenes,
      JSON.stringify(c.cast),
      c.hook,
      status,
      text,
      CHAPTER_SUMMARY[idx] || '',
      idx === 1 ? JSON.stringify(REVIEW_1) : null,
      wc,
      createdAt,
      updatedAt
    );
    chapterIds.set(idx, Number(ci.lastInsertRowid));
  });

  /* 版本历史：第一章保留一版早期稿 + 当前稿，第二、三章各留一版 */
  const revRows = [
    { idx: 1, content: CH1_DRAFT, reason: 'generate', days: 3 },
    { idx: 1, content: CH1, reason: 'manual', days: 2 },
    { idx: 2, content: CH2, reason: 'generate', days: 2 },
    { idx: 3, content: CH3, reason: 'batch', days: 0 },
  ];
  for (const rv of revRows) {
    run(
      'INSERT INTO chapter_revisions (project_id, chapter_id, content, word_count, reason, created_at) VALUES (?,?,?,?,?,?)',
      projectId, chapterIds.get(rv.idx), rv.content, countWords(rv.content), rv.reason, isoDaysAgo(rv.days, 22, 40)
    );
  }

  for (const th of THREADS) {
    run(
      `INSERT INTO threads (project_id, name, kind, status, detail, planted_chapter, last_chapter, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      projectId, th.name, th.kind, th.status, th.detail, th.planted_chapter, th.last_chapter,
      isoDaysAgo(3, 22, 50), isoDaysAgo(0, 22, 50)
    );
  }

  /* 近一周码字记录：今天仍有产出，连续 4 天 */
  const log = [
    [6, 0], [5, 540], [4, 0], [3, 870], [2, 1020], [1, 680], [0, 390],
  ];
  for (const [days, words] of log) {
    run('INSERT INTO writing_log (project_id, day, words) VALUES (?,?,?)', projectId, dayKeyOffset(days), words);
  }

  /* 示例调用记录，让「用量」页也有内容可看 */
  const calls = [
    ['directions', 'mock-1', 900, 620, 2],
    ['world', 'mock-1', 1500, 1100, 2],
    ['characters', 'mock-1', 1300, 980, 2],
    ['outline', 'mock-1', 1800, 900, 2],
    ['chapter_plan', 'mock-1', 1200, 760, 2],
    ['write', 'mock-1', 4200, 2100, 3],
    ['post_write', 'mock-1', 3800, 620, 3],
    ['review', 'mock-1', 3600, 880, 3],
    ['write', 'mock-1', 4100, 1980, 2],
    ['post_write', 'mock-1', 3700, 600, 2],
    ['write', 'mock-1', 4050, 2040, 0],
    ['post_write', 'mock-1', 3750, 610, 0],
  ];
  calls.forEach(([step, model, input, output, days], i) => {
    run(
      `INSERT INTO ai_calls (project_id, chapter_id, step, model, input_tokens, output_tokens, cached_tokens, estimated, status, error, duration_ms, summary, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      projectId, null, step, model, input, output, 0, 0, 'ok', null, 800 + i * 40,
      `${step} · 示例数据`, isoDaysAgo(days, 21, 10 + i)
    );
  });

  run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), projectId);
  return { created: true, project: get('SELECT * FROM projects WHERE id = ?', projectId) };
}
