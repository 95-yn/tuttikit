# TuttiKit · 项目介绍

> 一句话定位：**给你自己整一套能用、能改、能扩的多 Agent 框架**。
> 不整虚的，git clone 拉下来配一个 API Key，五分钟跑通；想接啥模型、加啥工具，照着文件名往里塞就完事。

---

## 这是个啥

简易 **agents 框架** + 现成的对话 Web/移动端。**单人独立部署**就能用，不依赖任何云服务、不要数据库、不要 Docker（真要也行）。装好 pnpm 和 Node 18+，`pnpm dev` 一把梭。

它干啥呢：

- 你跟它唠嗑，**Conductor 主 Agent** 自己判断是直接答、调工具、还是把活分给 Researcher / Coder / Reviewer 几个小弟去干
- 模型可以**随便换** —— Anthropic / OpenAI / DeepSeek / 离线 Mock，一行 `.env` 切
- 给它扔**图片、PDF**，它解析了喂给 LLM，纯文本模型也能"看见"
- 桌面上聊到一半，**手机扫个码接着聊**，数据实时同步
- 把 Claude Code 风格的 **Skill 文件**扔进 `.claude/skills/`，模型就懂得啥时候调用了
- **MCP 协议**支持，社区那一堆现成的 MCP server 直接接进来用

整明白了？说白了就是：**自己的 AI 助手，自己说了算**。

---

## 能干啥事儿（实际场景）

| 场景 | 怎么干的 |
| --- | --- |
| **"调研下 pgvector，写到 ./data/notes.md"** | Conductor → delegate_to_researcher（搜资料）→ delegate_to_coder（写文件）→ delegate_to_reviewer（审查），三层 agent 自动协作 |
| **"算下 (128×37+256)÷8"** | Conductor → calculator 工具 → 直接出结果，不心算瞎猜 |
| **"帮我看下这张图里写的啥"** | 上传图 → tesseract OCR 抽文本（即便用 DeepSeek 这种纯文本模型也照样能"看"）|
| **"分析这份 PDF 报告的要点"** | 上传 PDF → pdf-parse 抽文本（50 页内毫秒级）→ 喂模型；Claude 直接看原文，其他模型看抽取文本 |
| **手机端继续未完的对话** | 扫页面右下角 QR → 实时同步会话列表 + 历史消息，PC 发完一句话手机 3 秒内显示 |
| **接入你私有的 MCP server** | `.mcp.json` 加一项 → 重启 → 远端工具自动以 `mcp__<server>__<tool>` 出现在工具表里 |

---

## 它会的能力清单（杠杠的）

### 🤖 Agent 协作
- **Conductor 主 Agent**：持完整对话历史，每步由 LLM 决定调啥
- **3 个 sub-agent**：Researcher（调研） / Coder（写文件） / Reviewer（审查）
- **Agent as Tool 模式**：sub-agent 包装成 `delegate_to_*` 工具，主 agent 看到的世界就是"一堆工具"，编排逻辑零特殊处理
- **ReAct 循环**：自动多步推理 → 调用工具 → 拿结果 → 再推理，直到给出最终答复
- **Trace 完整记录**：每次 turn 的所有 LLM 调用 + 工具调用 + sub-agent 调用全程嵌套记录，落 `data/traces/<id>.json`

### 🔌 LLM Provider
| Provider | 文本 | 图片 | PDF |
| --- | :-: | :-: | :-: |
| Anthropic (Claude 3.5+) | ✓ | 原生 ✓ | 原生 ✓ |
| OpenAI (GPT-4o) | ✓ | 原生 ✓ | 抽取文本 |
| DeepSeek | ✓ | OCR 文本 | 抽取文本 |
| Mock（离线） | ✓ | OCR 文本 | 抽取文本 |
- 通过 Vercel AI SDK 抽象，加新 provider 一个 `case` 的事
- 无 API Key 自动 fallback 到 Mock，**先跑通再花钱**

### 📎 多模态
- 图片 / PDF 上传，**OCR 与 PDF 文本抽取在上传时同步完成**，元数据落盘
- 不支持原生多模态的 provider 自动注入 `<attachment>` 标签包裹的抽取文本
- 25MB 大小限制，可调

### 📚 Skills 系统
- **完全兼容 Claude Code skills**：`.claude/skills/<name>/SKILL.md` 直接能用
- frontmatter 解析（`name`、`description`）
- 模型通过 `find_skills(query)` + `invoke_skill(name)` 按需加载
- 项目级 + 用户全局两层，项目覆盖全局

### 🔗 MCP 集成
- 支持 **stdio + HTTP/SSE** 两种传输
- `.mcp.json` 配置 → 启动期自动连接 → 工具自动进 Conductor 工具表
- 远端工具命名 `mcp__<server>__<tool>`，跟 Claude Code 一个约定
- 失败的 server 跳过、不阻断启动

### 🌐 Web 端
- **暗色 OLED 风格**，Plus Jakarta Sans + 系统字体回退（国内不卡）
- **流式输出**：token 逐字浮现，可中断
- **Markdown 渲染**：代码高亮（highlight.js）+ Mermaid 流程图（懒载 + 20s 超时）
- **工具调用折叠面板**：每次调用看得到 input/output 完整对照
- **附件渲染**：图片缩略图 + PDF 卡片（含文件名/页数/抽取字数徽章）

### 📱 移动端
- **响应式**：≤720px 自动汉堡 + 抽屉式侧栏
- **触屏左滑关侧栏**
- **页面右下角 QR**：扫码即进，自己扫自己 PC
- **断流恢复**：iOS 切回前台主动重连 SSE，30s 心跳超时
- **Chunk 失配自动 reload**：dev 模式改完代码移动端不卡死
- **中文文件名**：multer `defParamCharset:'utf8'`，UTF-8 全链路

### 🔄 跨设备同步
- 后端全局事件总线（`/events` SSE）
- PC 发消息 → 手机 1-3 秒内看到
- 删除 / 重命名会话实时反映
- 自己发起的 turn 不会被广播反向覆盖（本地状态领先）

### 💾 持久化
- **会话**：`data/sessions/<id>.json`，重启不丢
- **Trace**：`data/traces/<id>.json`，每次 turn 完整快照
- **长期记忆**：`data/long_term_memory.json`，关键词 + 时间衰减打分
- **上传**：`data/uploads/<id>.<ext>` + 元数据 JSON
- 全部本地文件，**没有 Postgres，没有 Redis，没有 S3**，零运维

### 🛠️ 工程
- **Monorepo**：pnpm workspaces，apps/server + apps/web
- **TypeScript 全栈**：strict 模式，noEmit，tsx 直跑（无编译步骤）
- **84 个测试断言**：AI SDK 集成 21 + Conductor 12 + Markdown 34 + Skills 9 + MCP 8
- **一键启动脚本**：`pnpm dev` 自动检测 + 清理端口冲突 + 打印 LAN URL
- **生产构建 125KB**：First Load JS，移动端秒开

---

## 跟别的比，优势在哪

跟 **Claude Code / Cursor** 比：
- **你能改源码** —— 这是个开源的小骨架，加 prompt 改逻辑塞工具，都是你自己说了算；Claude Code 是黑盒
- **能换模型** —— 不绑 Anthropic，DeepSeek 一个月几块钱跑通整套
- **能放自己服务器** —— 数据落自己硬盘，不走任何云

跟 **LangChain / LangGraph** 比：
- **代码量小很多** —— 整个后端 ~3000 行 TS，看一遍能看明白；不像 LangChain 那样深拷贝抽象一层套一层
- **不要 Python 依赖** —— 纯 Node 生态，前后端同语言
- **不画"图"** —— ReAct 循环是直接代码，不搞 graph DSL，调试简单
- 缺点：没 LangChain 那么多内置 chain / template，但**对应位置都是 5-20 行能写的事儿**

跟 **从零写** 比：
- **现成的 Web UI**：Next.js 15 + 暗色风格 + 响应式 + 移动端二维码 + 流式 + 附件，全套都有
- **现成的多设备同步**：SSE 全局广播，扔到自己服务器就能跨端用
- **现成的 trace 体系**：每次 turn 嵌套调用全部记录，调试不抓瞎
- **现成的 skills + MCP 接入**：社区现成的 skill 和 MCP server 拿来即用

---

## 5 分钟跑起来

```bash
# 装一下
git clone <repo>
cd tuttikit
pnpm install

# 配 .env（可选；不配也能跑，自动 mock）
cp apps/server/.env.example apps/server/.env
# 然后填一个 DEEPSEEK_API_KEY 之类的，最便宜

# 起服务
pnpm dev
```

浏览器打开 `http://localhost:3000`，就这。

**手机想用**：

启动 banner 里那个 `📱 http://192.168.x.x:3000` 直接扫码，或者 PC 页面右下角有 QR。

**接 MCP server**：

```bash
cp .mcp.json.example .mcp.json
# 编辑加你要接的 server
```

**塞 skill**：

```bash
mkdir -p .claude/skills/my-skill
# 写一个 SKILL.md，frontmatter 加 name + description，正文写指令
```

详细的「想改 X 看哪个文件」全在 [`STRUCTURE.md`](./STRUCTURE.md)。

---

## 适合谁

✅ **适合**：
- 想自己跑一个不联网（除 LLM API）的私人 AI 助手
- 想理解多 Agent 系统**到底是咋实现**的（代码量少，能逐文件读懂）
- 想给团队整一个**可定制**的对话工具，加自己业务的工具进去
- 想试 Claude Code 风格 skill 但不想被锁在 Claude Code 里
- 已经有 MCP server，想找个能跑得动的 client 试

❌ **不适合**：
- 想要"一键部署 SaaS"的产品级体验 —— 本项目是骨架不是成品
- 多用户 / 鉴权 / 计费这套 —— 没有，是单租户 demo
- 高并发生产环境 —— SSE 长连接没做横向扩展，会话存文件不存数据库
- 国内合规要求 —— 没做内容过滤，自己加

---

## 已经在路上 / 想加但还没加的

可预期会逐步落地的（按收益从大到小）：

| 想加的 | 价值 | 难度 |
| --- | --- | --- |
| **RAG / 向量记忆** | 把 longTerm.search() 的关键词换成 embedding + cosine，长期记忆质量飞跃 | 中 |
| **更多 LLM provider**（智谱/通义/Gemini） | aisdk.ts 加 case；用户选择多 | 低 |
| **真实 web 搜索** | 替换 webSearch.ts 的 handler 接 Tavily / Serper | 低 |
| **Trace 可视化** | 现在 trace 落 JSON，加个 `/traces/:id` 树状图 UI 看嵌套调用 | 中 |
| **多用户鉴权** | session 加 userId 维度，集成 magic link 或 OAuth | 高 |
| **Docker 一键部署** | Dockerfile + docker-compose，云上 5 分钟 | 低 |
| **Skill marketplace** | 把社区 skill 做成可订阅的索引，pnpm install 装 skill 包 | 中 |

如果你想接其中某个，[`STRUCTURE.md`](./STRUCTURE.md) 都有对应「改哪些文件」的查找表。

---

## 几个数字

- 后端 TypeScript：**33 个 .ts 文件 ≈ 3000 行**（含全部 agent / 工具 / LLM / 上传 / MCP / skills）
- 前端 TypeScript：**13 个组件 + 4 个 hook + lib ≈ 1800 行 .ts/.tsx**
- 全栈样式：**1 个 globals.css ≈ 1400 行**（OLED 暗色 + 响应式）
- 测试断言：**84 个**，全过
- 文档：README + STRUCTURE + ARCHITECTURE + spec + 这份 OVERVIEW，**5 份文档把项目讲明白**

---

## 怎么开始

1. 5 分钟先跑通：上面那段 `pnpm dev`
2. 想理解架构：[`apps/server/ARCHITECTURE.md`](./apps/server/ARCHITECTURE.md)（后端模块 / Agent 协议 / 事件协议）
3. 想改东西：[`STRUCTURE.md`](./STRUCTURE.md)（「我想做 X」→「改这些文件」）
4. 想看怎么实现的：直接读 `apps/server/src/`，文件名都不绕，3000 行读得完

---

整明白了？有啥不顺手的地方 issue 上提，能改的都改了。**先跑通，再改造，是这个项目的态度。**
