# NovelWriter · 小说创作平台

> 人管控、AI 管写 —— 从一句灵感，到一本有骨架、有世界、有正文的书。

NovelWriter 是一个**本地运行、自带 Key** 的 AI 小说创作平台。

![概览](docs/ui/02-overview.png)

## 核心理念

- **积木式架构**：先把骨搭稳——方向 → 世界 → 人物 → 卷纲 → 章节任务单，每块积木都可 AI 起草、人工修改。
- **人管控、AI 管写**：AI 生成的一切先进入你的视野（跟随写入可关、生成结果可采纳或放弃），只有你确认的内容才会成为书的一部分。
- **上下文即记忆**：正文生成时自动注入创作约定、世界设定、出场人物卡与**当前状态**、**最近章节摘要**、**进行中的伏笔线索**、写法规则、反 AI 规则与上一章结尾——写得越长，记得越牢。
- **数据完全本地**：SQLite 单文件（`server/data/novelwriter.db`），API Key 只存本机，随时导出 Markdown / TXT。

## 功能总览

| 模块 | 说明 |
| --- | --- |
| 书架与开书向导 | 一句灵感 → AI 生成 3 个差异明显的候选方向（题材/卖点/人设/约定）→ 选定建书；支持长篇与短篇（3千~3万字） |
| 世界手册 | 地理/势力/规则/物品/历史五类设定，AI 起草自动去重，人工可增改 |
| 角色库 | 角色卡（欲望/缺陷/外貌/**当前状态**）+ 关系网；每章写完自动同步角色处境 |
| 架构规划 | AI 卷纲（阶段目标/冲突/钩子）→ 逐卷拆章（任务/场景/出场人物/章末钩子），全部可编辑 |
| 写作台 | SSE 流式整章生成、光标续写、选中改写；防抖自动保存；AI 责编检查（任务完成度/一致性/文风/节奏，问题分级） |
| 故事记忆 | 每章写完自动生成 80–120 字摘要；后续章节自动带上最近前情提要，长篇不靠「翻前文」也能接住 |
| 伏笔线索 | 写后自动回流「新埋 / 推进 / 回收 / 放弃」，也可人工维护或从已有正文补录；进行中的线索会注入下一次生成 |
| 版本历史 | 保存与生成自动留快照（每章最近 80 个版本），可预览、回滚；回滚前先为当前正文留档 |
| 批量连写 | 选定章节范围连续生成 → 保存 → 写后整理 → 检查；任务落库，可暂停 / 继续 / 取消，关掉页面仍在后台推进 |
| 码字统计 | 每日字数、连续写作天数、最高单日与最近 14 天节奏图 |
| 示例作品 | 书架一键载入《灯下黑》示例书：3 卷 18 章骨架、3 章正文、5 条伏笔线索、版本历史与码字统计，零模型调用 |
| 写法引擎 | 全局与本书两级「写法资产」+「反 AI 规则」，启用即注入生成与修文 |
| 模型设置 | OpenAI 兼容接口（DeepSeek/Kimi/GLM/Qwen/OpenAI…），按任务路由模型（规划/正文/审阅），连接测试 |
| 用量与运行记录 | 按步骤/模型统计 tokens，每次调用留痕可追溯 |
| 导出 | 整书 Markdown / TXT 一键下载 |

**Mock 演示模式**：未配置 API Key 时，内置演示引擎会生成结构化示例内容，零成本跑通「方向→世界→角色→卷纲→拆章→正文→检查→写后整理→批量连写→导出」全流程（正文会标注「Mock 演示」）。

**内置示例作品**：不想从零开始，可在书架点「载入示例作品」，直接写入一本《灯下黑》示例书。它包含 3 卷 18 章骨架、3 章完整正文、5 条伏笔线索、版本历史、近一周码字记录与调用记录，不调用任何模型，适合先看完整形态。

## 快速开始

环境要求：Node.js ≥ 20.19（推荐 22/24）。

```bash
npm install          # 根目录（仅开发脚本依赖）
npm --prefix server install
npm --prefix client install

npm run dev          # 同时启动 服务端:3000 + 前端 Vite:5173
```

打开 `http://localhost:5173`（开发模式，/api 自动代理到 3000）。

**生产模式**（服务端直接托管前端构建产物，只开一个端口）：

```bash
npm run build        # 构建 client/dist
npm start            # 打开 http://127.0.0.1:3000
```

第一次使用建议路径：

1. 想先看完整形态：在书架点「载入示例作品」，直接得到一本可读、可改、可回滚的示例书；想从零开始则继续下一步。
2. 打开「模型设置」：直接体验选 Mock 演示模式；正式创作选 OpenAI 兼容接口，填 API 地址、Key 与模型（可给规划/正文/审阅配不同模型），点「测试连接」。
3. 书架「新建作品」：写下一句灵感，选长篇或短篇。
4. 「方向」页生成候选方向并选定 —— 生成全书创作约定。
5. 「世界手册」「角色库」各点一次 AI 起草，再按喜好修改。
6. 「架构规划」生成卷纲 → 逐卷拆章。
7. 进「写作台」，选一章点「AI 生成本章」，看正文流式写出；写完自动保存并做「写后整理」（摘要 + 角色状态 + 伏笔线索）；点「AI 检查本章」看责编意见。
8. 想连续推进时点「批量连写」选章节范围；写偏了可在「历史版本」里回滚。
9. 右上角「导出 MD / TXT」随时带走全书。

## 目录结构

```
NovelWriter/
├─ package.json           # 根脚本：dev / build / smoke / ui:check
├─ scripts/
│  ├─ dev.mjs             # 前后端联调启动器
│  ├─ smoke.mjs           # 全链路冒烟测试（Mock 模式，48 项断言）
│  └─ ui-check.mjs        # Edge 无头浏览器 UI 验证（截图到 docs/ui/）
├─ server/                # Express 5 + node:sqlite（零原生依赖）
│  └─ src/
│     ├─ index.js         # 应用入口（生产模式托管 client/dist）
│     ├─ db.js            # 建库建表 + 轻量迁移 + 默认规则种子
│     ├─ demo.js          # 内置示例作品（静态内容，不调用模型）
│     ├─ ai.js            # AI 网关：OpenAI 兼容流式 / 模型路由 / 用量记录
│     ├─ pipeline.js      # 创作管线：上下文 / 写后整理 / 检查 / 快照 / 保存与统计
│     ├─ batch.js         # 批量连写任务运行时（暂停 / 恢复 / SSE 进度）
│     ├─ mock.js          # Mock 演示引擎（无 Key 体验全流程）
│     ├─ prompts.js       # 提示词库（12 个创作环节）
│     └─ routes/          # projects / writing(SSE) / batch / system / demo
└─ client/                # Vite + React 19 + TypeScript
   └─ src/
      ├─ pages/           # 书架 / 概览 / 方向 / 世界 / 角色 / 规划 / 写作台 / 伏笔线索 / 规则 / 用量 / 设置
      ├─ components/ui.tsx
      └─ styles.css       # 「墨·纸·朱砂」设计系统
```

## API 一览

```
GET    /api/health                         健康检查（含 mock 标记）
GET/PUT /api/settings                      模型设置      POST /api/settings/test 连接测试
GET/POST /api/projects                      书架          GET/PATCH/DELETE /api/projects/:id
POST   /api/projects/:id/directions        AI 候选方向
POST   /api/projects/:id/world/generate    AI 起草设定   POST/PUT/DELETE 世界条目 CRUD
POST   /api/projects/:id/characters/generate  AI 起草角色  POST/PUT/DELETE 角色、关系 CRUD
POST   /api/projects/:id/outline           AI 卷纲       POST /api/projects/:id/volumes/:vid/plan 拆章
GET/POST/PUT/DELETE /api/projects/:id/chapters…   章节管理
PUT    /api/projects/:id/chapters/:cid/content?sync=1   保存正文（sync=1 时写后整理并自动留快照）
POST   /api/projects/:id/chapters/:cid/write|continue|rewrite   SSE 流式生成
POST   /api/projects/:id/chapters/:cid/review|sync-state        检查 / 写后整理（摘要+角色+伏笔）
GET    /api/projects/:id/chapters/:cid/revisions                版本列表
GET    /api/projects/:id/chapters/:cid/revisions/:rid           版本详情
POST   /api/projects/:id/chapters/:cid/revisions/:rid/restore   回滚
POST   /api/projects/:id/chapters/:cid/revisions                手动存档
GET/POST/PUT/DELETE /api/projects/:id/threads…                  伏笔线索
POST   /api/projects/:id/threads/extract                        从正文补录线索
POST   /api/projects/:id/batches                                创建批量连写
GET    /api/projects/:id/batches[/:bid]                         任务列表 / 状态
POST   /api/projects/:id/batches/:bid/attach|pause|resume|cancel 进度流 / 暂停 / 继续 / 取消
POST   /api/demo                            一键载入内置示例作品（幂等）
GET    /api/stats?projectId=               每日码字统计与连续天数
GET    /api/rules?projectId=  POST/PUT/DELETE /api/rules…   写法规则
GET    /api/usage?projectId=               用量与运行记录
GET    /api/projects/:id/export?format=md|txt              导出
```

## 测试

```bash
npm run smoke      # 后端全链路（隔离临时库，无需 Key）：48 项断言
npm run ui:check   # 浏览器 UI 验证（需本机 Edge，截图输出到 docs/ui/）
```

## 设计细节

- **SSE 流式**：服务端以 `text/event-stream` 推送 `start/delta/done/error` 四类事件；客户端断开时中止写入。
- **上下文分层注入**：书级约定 → 世界规则 → 人物状态 → 写法/反AI规则 → 伏笔线索 → 前情摘要 → 上一章结尾 → 本章任务，稳定资料前置，正文任务后置，对厂商的输入缓存友好。
- **字数口径**：全书统一「去空白字符计数」，前后端一致。
- **容错 JSON 解析**：AI 返回的 JSON 自动剥离围栏与说明文字，容忍尾逗号与中文引号。
- **写后整理**：每章保存后由审阅模型一次调用产出「章节摘要 + 角色状态 + 伏笔线索」，减少连续创作中的重复消耗（可在书页右上角关闭自动整理）。
- **版本快照**：自动保存默认 60 秒内合并，生成 / 批量 / 回滚等关键节点强制留档；每章最多保留 80 个版本。
- **批量连写**：任务落库、运行时在内存；暂停在「当前章写完后」生效，取消会中止正在进行的模型请求；页面断开不影响后台推进。

## License

MIT
