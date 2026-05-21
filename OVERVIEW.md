# TuttiKit · 项目介绍

> 一句话定位：**给你自己整一套能用、能改、能扩的多 Agent 框架**。
> 不整虚的，git clone 拉下来配一个 API Key，五分钟跑通；想接啥模型、加啥工具，照着文件名往里塞就完事。

---

## 这是个啥

简易 **agents 框架** + 现成的对话 Web/移动端。**单人独立部署**就能用，不依赖任何云服务、不要数据库、不要 Docker（真要也行）。装好 pnpm 和 Node 18+，`pnpm dev` 一把梭。

它干啥呢：

- 你跟它唠嗑，**Conductor 主 Agent** 自己判断是直接答、调工具、还是把活分给 Researcher / Coder / Reviewer 几个小弟去干
- 复杂任务自动 **Plan-and-Execute**：先拆步骤再分步跑；某步失败自动 re-plan 换路子
- 模型可以**随便换** —— Anthropic / OpenAI / DeepSeek / 离线 Mock，一行 `.env` 切；主限流自动 fallback 到备用
- 给它扔**图片、PDF**，它解析了喂给 LLM，纯文本模型也能"看见"
- 桌面上聊到一半，**手机扫个码接着聊**，数据实时同步
- 把 Claude Code 风格的 **Skill 文件**扔进 `.claude/skills/`，模型就懂得啥时候调用了（含 `~/.claude/plugins/marketplaces/` 装的，50+ 个开箱即用）
- **MCP 协议**支持，社区那一堆现成的 MCP server 直接接进来用（含信任边界 + tool 翻译）
- 对话框打 `/` 弹面板，**直接强制调某个 skill / MCP tool**
- 全套 **预算守卫** + **评测体系** + **可观测**：单会话上限、35+ 端到端任务、trace 嵌套树 + 多 provider A/B replay

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

### 🤖 Agent 协作 + 规划
- **Conductor 主 Agent**：持完整对话历史，每步由 LLM 决定调啥
- **3 个 sub-agent**：Researcher（调研） / Coder（写文件） / Reviewer（审查）
- **Agent as Tool 模式**：sub-agent 包装成 `delegate_to_*` 工具，主 agent 看到的世界就是"一堆工具"，编排逻辑零特殊处理
- **ReAct 循环**：自动多步推理 → 调用工具 → 拿结果 → 再推理，直到给出最终答复
- **Plan-and-Execute V1/V2**：复杂任务先调 Planner 拆 steps，注入 system（V1）或显式逐步执行（V2，含 `plan:step:start/end` 事件 + 失败 re-plan 一次）
- **Self-Critique**：终答前用 LLM 内省审校，`REVISE:` 触发再跑一轮（默认关）
- **Auto-Review on code write**：写代码文件时自动 emit `review:needed` 事件，UI 可提示用户审查
- **Trace 完整记录**：每次 turn 的所有 LLM 调用 + 工具调用 + sub-agent 调用全程嵌套记录，落 `data/traces/<id>.json`
- **Trace Replay**：换 provider 重跑同一对话；A/B 多 provider 并发对比

### 🔌 LLM Provider + 韧性
| Provider | 文本 | 图片 | PDF |
| --- | :-: | :-: | :-: |
| Anthropic (Claude 3.5+) | ✓ | 原生 ✓ | 原生 ✓ |
| OpenAI (GPT-4o) | ✓ | 原生 ✓ | 抽取文本 |
| DeepSeek | ✓ | OCR 文本 | 抽取文本 |
| Mock（离线） | ✓ | OCR 文本 | 抽取文本 |
- 通过 Vercel AI SDK 抽象，加新 provider 一个 `case` 的事
- 无 API Key 自动 fallback 到 Mock，**先跑通再花钱**
- **Provider fallback chain**：主限流（429）/ 服务 outage 时自动切到 `LLM_FALLBACK_CHAIN` 上的下一个
- **Retry + backoff**：429 / 5xx 指数退避重试（默认 3 次）
- **AbortController 全链路**：用户关页 / Stop / 服务 drain 时正在跑的 tool 调用立即中断

### 💰 成本与预算
- **BudgetGuard**：单会话 / 单日 USD 上限；80% 阈值预警 emit 到 UI；超限硬拦截 `turn:error`
- **Pricing 表**：4 个 provider × 多 model 的 input/output/cacheRead 单价；前缀匹配自适应版本
- **Anthropic prompt cache**：≥1024 token 的 system prompt 自动挂 `cacheControl`，输入价 -90%
- **LLM 响应缓存**：开发 / eval 时启用（`LLM_CACHE=true`），相同请求秒返不烧 API

### 📎 多模态
- 图片 / PDF 上传，**OCR 与 PDF 文本抽取在上传时同步完成**，元数据落盘
- 不支持原生多模态的 provider 自动注入 `<attachment>` 标签包裹的抽取文本
- 25MB 大小限制，可调

### 📚 Skills 系统
- **完全兼容 Claude Code skills**：`.claude/skills/<name>/SKILL.md` 直接能用
- **三处自动扫**：项目级 + `~/.claude/skills/`（软链跟随） + `~/.claude/plugins/marketplaces/`（用 `/plugin install` 装的）
- 开箱即用 50+ 个 skill（superpowers + Claude Code 官方 marketplace）
- frontmatter 解析（`name`、`description`）；优先级 plugin < user < project
- 模型通过 `find_skills(query)` + `invoke_skill(name)` 按需加载
- **`/skills` Web 管理页**：列表 + 详情 + 按需翻译成中文（`data/skills-zh/<name>.zh.md`）
- **批量翻译列表名**：50+ 个 skill 的显示名一次翻完（`data/skills-zh/_names.zh.json`）
- **Reload 不重启**：磁盘改完 SKILL.md 点 `↻ Reload` 热更新

### 🔗 MCP 集成
- 支持 **stdio + HTTP/SSE** 两种传输
- `.mcp.json` 配置 → 启动期自动连接 → 工具自动进 Conductor 工具表
- 远端工具命名 `mcp__<server>__<tool>`，跟 Claude Code 一个约定
- 失败的 server 跳过、不阻断启动
- **信任边界**：`trusted: false` 必须给 `allowTools` 白名单；防 untrusted server 注册任意 tool
- **`/mcp` Web 管理页**：状态圆点 / tool 列表 / 单 server Reconnect 不重启 / tool 翻译
- **AbortSignal 透传**：用户 stop → MCP `callTool` Promise.race 上 signal，立即拒绝

### ⚡ `/` slash 命令
- 输入框打 `/` 弹下拉面板，列出 50+ skill + 所有 MCP tool
- 顶部 tab 切「全部 / Skills / MCP」
- 实时过滤 + `↑↓ Enter Esc` 键盘全套
- 选完自动 inject `请使用 skill \`<name>\` 完成：|` 模板，光标停在 `|`

### 🔍 RAG / 长期记忆
- **Embedding 抽象**：OpenAI `text-embedding-3-small` / Mock（hash 派生，离线测试）
- **混合检索**：关键词 + 向量两个 ranker → RRF (Reciprocal Rank Fusion) 合并 top-k
- **去重 + 压缩**：sha1 exact dedup → cosine ≥0.95 向量 dedup → 超量按 cluster 聚类 + LLM 合并摘要
- **VectorStore 接口**：InMemoryVectorStore 内置，sqlite-vec 迁移文档预留（`docs/agent-roadmap/sqlite-vec-migration.md`）

### 🌐 Web 端
- **三套主题**：dark / light / 跟随系统，localStorage 持久不闪
- **流式输出**：token 逐字浮现 + rAF 批处理（避免长答 setState 风暴）+ 可中断
- **Markdown 渲染**：代码高亮（highlight.js）+ Mermaid 流程图（懒载 + 20s 超时）
- **工具调用折叠面板**：每次调用看得到 input/output 完整对照
- **附件渲染**：图片缩略图 + PDF 卡片（含文件名/页数/抽取字数徽章）
- **三个管理页**：`/skills` `/mcp` `/traces`，全部虚拟滚动（VirtualList 零依赖，固定行高 + overscan + RAF）
- **顶部浮层通知**：budget 警告 / review 建议 / critique 修订 / plan 步骤进度 共 4 类
- **CtxMeter**：上下文 + 累计 USD + 80% 黄 100% 红 状态颜色
- **Cmd+K Command Palette**：fuzzy 搜会话 + 操作 + provider 切换

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
- **长期记忆**：`data/long_term_memory.json`，含 embedding（混合检索）+ dedup + LRU
- **上传**：`data/uploads/<id>.<ext>` + 元数据 JSON + LRU buffer 缓存
- **Eval 报表**：`data/eval-runs/<run>.json` + `latest-<provider>.json`（regression diff baseline）
- **Skills/MCP 翻译**：`data/skills-zh/`、`data/mcp-zh/`
- 全部本地文件，**没有 Postgres，没有 Redis，没有 S3**，零运维（10k 条目内）

### 🔒 安全
- **Helmet 头**：CSP / HSTS / X-Frame-Options 等默认子集
- **SSE 限流**：单 IP 最多 8 路 SSE 长连接
- **fileSystem 写入 allowlist + denylist**：默认只准 `data/ tmp/ output/`，`.env / .git / package.json` 严禁
- **Prompt injection 防御**：附件抽取文本 `<user-attachment>` 标签隔离 + system 加防护语
- **MCP 信任边界**：`trusted: false` 强制 `allowTools` 白名单
- **Pre-commit hook**：拦小红书 / 草稿 / `.env` / `sk-*` 等敏感文件提交（`scripts/pre-commit.sh`）

### 📊 可观测 + 评测
- **Trace/Span**：自建嵌套 trace，`/traces` UI 可视化
- **Trace Replay**：单 + A/B 多 provider 并发对比
- **Eval Harness**：35+ golden tasks（9 个分类）+ LLM-as-judge + regression diff
- **`--fail-on-regression`** CI 门禁；`latest-<provider>.json` 当 baseline

### 🚢 部署
- **Dockerfile 多阶段** + `docker-compose.yml`（pnpm filter / volume / HEALTHCHECK）
- **`/ready` 健康检查**：env / 数据目录可写 / MCP 连接状态
- **Graceful drain**：SIGTERM 时等 in-flight turn 完成（30s 超时）
- **Zod env 校验**：缺 API key 在 boot 期挂，不等到第一个请求

### 🛠️ 工程
- **Monorepo**：pnpm workspaces，apps/server + apps/web
- **TypeScript 全栈**：strict 模式，noEmit，tsx 直跑（无编译步骤）
- **10 套测试 ~200 断言**：aisdk + conductor + markdown + skills + mcp + resilience + safety + budget + rag + planner
- **35+ 端到端 eval 任务**：9 个分类，含 safety-injection / multi-step / cancel 等
- **一键启动脚本**：`pnpm dev` 自动检测 + 清理端口冲突 + 打印 LAN URL
- **生产构建 ~110 KB** First Load JS，移动端秒开

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

## 已经做完的（v0.2）

按路线图 7 大方向 + 后续延伸，**全部落地**：

| 方向 | 主要产出 |
| --- | --- |
| **#1 Eval Harness** | 35+ golden tasks + LLM-as-judge + regression diff + `--fail-on-regression` CI 门禁 |
| **#2 RAG** | Embedding 抽象 + 混合检索 RRF + dedup + cluster summarization + VectorStore 接口 |
| **#3 Resilience** | Zod 入参 + 自修复 payload + withRetry + Provider fallback chain + AbortController 全链路 |
| **#4 Planning** | Plan-and-Execute V1（system 注入）+ V2（显式 step + 失败 re-plan）+ Self-Critique + Auto-Review |
| **#5 Cost & Budget** | BudgetGuard + Pricing 表 + Anthropic prompt cache + LLM 响应缓存 |
| **#6 Safety** | Helmet / SSE 限流 / write allowlist / 附件 injection 隔离 / MCP 信任 / pre-commit hook |
| **#7 Deployment** | Dockerfile + env 校验 + `/ready` + graceful drain + Trace Replay（单 + A/B 多 provider） |
| **延伸** | Skills/MCP 翻译 + 管理页 + `/` slash 命令 + VirtualList + 中英切换 + 落盘可查 |

详见 [`docs/agent-roadmap/`](./docs/agent-roadmap/) 7 篇方案 + `eval-real-llm-workflow.md` + `sqlite-vec-migration.md`。

## 还没做（明显的下一步）

| 想加的 | 价值 | 难度 |
| --- | --- | --- |
| **真 LLM eval baseline** | 跑一次真 provider 建立首个 baseline，后续改动 diff 才有意义 | 低（要 API key + 钱） |
| **sqlite-vec 持久化** | > 10k 条目时该上 | 中（编译依赖） |
| **更多 LLM provider**（智谱/通义/Gemini） | aisdk.ts 加 case | 低 |
| **真 web 搜索**（Tavily/Serper） | 替换 webSearch.ts | 低 |
| **多用户鉴权** | 团队 / 公司场景 | 高 |
| **plan:revised UI 时间轴** | 当前只用徽标，可以更细致 | 中 |

每条都有「改哪些文件」的查找表，见 [`STRUCTURE.md`](./STRUCTURE.md) 的 v0.2 新增模块清单。

---

## 几个数字

- 后端 TypeScript：**60+ 个 .ts 文件 ≈ 7000 行**（含 agent + 工具 + LLM + 上传 + MCP + skills + eval + planner + budget + RAG）
- 前端 TypeScript：**20+ 个组件 + 6 个 hook + 3 个管理页 ≈ 3500 行 .ts/.tsx**
- 全栈样式：**1 个 globals.css ≈ 2200 行**（dark + light + system + 响应式）
- 单元测试：**10 套 ~200 断言**，全过
- 端到端 eval：**35+ tasks**，9 个分类，全过（mock）
- 文档：README + STRUCTURE + OVERVIEW + SHOWCASE + ARCHITECTURE + 11 篇 agent-roadmap，**讲透项目**

---

## 怎么开始

1. 5 分钟先跑通：上面那段 `pnpm dev`
2. 想理解架构：[`apps/server/ARCHITECTURE.md`](./apps/server/ARCHITECTURE.md)（后端模块 / Agent 协议 / 事件协议）
3. 想改东西：[`STRUCTURE.md`](./STRUCTURE.md)（「我想做 X」→「改这些文件」）
4. 想看怎么实现的：直接读 `apps/server/src/`，文件名都不绕，3000 行读得完

---

整明白了？有啥不顺手的地方 issue 上提，能改的都改了。**先跑通，再改造，是这个项目的态度。**
