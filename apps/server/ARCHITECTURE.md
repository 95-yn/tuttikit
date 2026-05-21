# 多 Agent 对话系统 · 架构文档

> 类 Claude / Codex 的对话式多 Agent 系统。Node.js 实现，模型层走 Vercel AI SDK 可任意切换。
>
> 核心范式：**Agent as Tool** —— 一个主 Conductor 持有完整对话历史，按需动态调用工具或委派子 Agent；
> 节点数量与内容完全由 LLM 实时决定，UI 跟随事件流增量渲染。

---

## 1. 设计目标

| 目标 | 说明 |
| --- | --- |
| **类 ChatGPT 多轮对话** | 一个会话持续累积消息历史；用户能连问，Agent 能引用上文 |
| **节点不固定** | 每一步是直接答 / 调工具 / 委派子 Agent，由 LLM 决定，不预设阶段数 |
| **Agent as Tool** | researcher / coder / reviewer 作为 `delegate_to_*` 工具暴露给 Conductor，无特殊编排逻辑 |
| **模型可切换** | 统一走 Vercel AI SDK，Anthropic / OpenAI / DeepSeek / Mock 一行配置切换 |
| **会话持久化** | 落盘到 `data/sessions/<id>.json`，重启不丢；类 ChatGPT 侧边栏可看历史 |
| **流式优先** | LLM token → 事件总线 → SSE，Web UI 用 EventSource 增量渲染 |
| **可观测** | 自建 Trace/Span，token 用量、工具耗时、嵌套子 Agent 调用全量记录 |

---

## 2. 整体架构图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Entry Layer                                         │
│  ┌────────────────┐    ┌────────────────┐    ┌────────────────────┐          │
│  │  Web UI        │    │  CLI (chat)    │    │  programmatic      │          │
│  │  (public/)     │    │                │    │                    │          │
│  │  ▼ EventSource │    │                │    │                    │          │
│  │  Express HTTP  │    │                │    │                    │          │
│  │  /sessions /...│    │                │    │                    │          │
│  └────────┬───────┘    └────────┬───────┘    └─────────┬──────────┘          │
└───────────┼─────────────────────┼──────────────────────┼─────────────────────┘
            │                     │                      │
            ▼                     ▼                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                       ConductorAgent  (主对话 Agent)                         │
│                                                                              │
│  load session.messages  →  LLM (system + history + tools)                    │
│                              │                                               │
│                              ├─ 直接回答 → 流式 token → append assistant      │
│                              │                                               │
│                              └─ tool_calls[] → 执行每个工具:                  │
│                                     ├─ calculator                            │
│                                     ├─ web_search                            │
│                                     ├─ file_system_read / write              │
│                                     ├─ delegate_to_researcher ───┐           │
│                                     ├─ delegate_to_coder    ─────┤           │
│                                     └─ delegate_to_reviewer ─────┤           │
│                                                                  ▼           │
│                                            ┌──────────────────────────────┐ │
│                                            │  子 Agent (BaseAgent ReAct)  │ │
│                                            │  独立 ShortTermMemory        │ │
│                                            │  独立工具子集（受限权限）    │ │
│                                            └──────────────────────────────┘ │
│                                                                              │
│  → append tool message → 回到 LLM 循环（直到无 tool_calls 或 maxSteps）       │
└──────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Cross-cutting          │ Persistence          │ LLM Layer                   │
│  ─ MessageBus (事件)    │ ─ SessionManager     │  ─ AISDKProvider            │
│  ─ Logger (pino)        │   data/sessions/...  │  ─ MockProvider             │
│  ─ Tracer (span/usage)  │ ─ LongTermMemory     │     ▼ Vercel AI SDK         │
│  ─ SSE Streamer         │   data/...json       │  @ai-sdk/anthropic          │
│                         │ ─ Trace 文件落盘     │  @ai-sdk/openai             │
│                         │   data/traces/...    │  @ai-sdk/openai-compatible  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 目录结构

```
tuttikit/
├── ARCHITECTURE.md          # 本文档
├── README.md                # 60 秒上手
├── package.json
├── .env.example
│
├── public/                  # ── Web UI（无框架，原生 JS） ──
│   ├── index.html           # 左侧会话列表 + 主消息流 + 底部输入框
│   ├── styles.css           # 暗色主题
│   └── app.js               # EventSource 监听事件，增量渲染
│
├── src/
│   ├── config.js
│   ├── server.js            # Express + SSE 入口
│   ├── cli.js               # 终端聊天（连续多轮 / 一次性）
│   │
│   ├── llm/                 # 模型抽象层
│   │   ├── base.js          # BaseLLM 接口
│   │   ├── aisdk.js         # AISDKProvider（统一 Anthropic/OpenAI/DeepSeek）
│   │   ├── mock.js          # 离线剧本，无 API Key 也能跑
│   │   └── index.js         # createLLM(providerName)
│   │
│   ├── agents/
│   │   ├── base.js          # BaseAgent —— 单次任务 ReAct 循环
│   │   ├── conductor.js     # ConductorAgent —— 持续对话主 Agent
│   │   ├── researcher.js    # 子 Agent（调研）
│   │   ├── coder.js         # 子 Agent（写文件）
│   │   ├── reviewer.js      # 子 Agent（审查）
│   │   └── index.js
│   │
│   ├── tools/
│   │   ├── registry.js
│   │   ├── calculator.js    │
│   │   ├── fileSystem.js    │ 普通工具
│   │   ├── webSearch.js     │
│   │   ├── delegate.js      # makeDelegateTool() —— 子 Agent 包装成工具
│   │   └── index.js         # buildToolRegistryWithSubAgents()
│   │
│   ├── memory/
│   │   ├── shortTerm.js     # 子 Agent 内部使用的滑动窗口
│   │   └── longTerm.js      # 跨会话沉淀（researcher 结论自动写入）
│   │
│   ├── observability/
│   │   ├── logger.js        # pino + pino-pretty
│   │   └── tracer.js        # 自建 span，落盘 data/traces/<id>.json
│   │
│   ├── streaming/
│   │   └── sse.js           # bus → SSE
│   │
│   └── core/
│       ├── messageBus.js    # EventEmitter
│       └── session.js       # SessionManager（CRUD + 文件落盘）
│
├── examples/
│   ├── test-aisdk-integration.js   # AI SDK 消息映射 / tool-call / streaming 20 断言
│   └── test-conductor.js           # Conductor + 多轮 + delegate 12 断言
│
└── data/
    ├── sessions/<id>.json   # 每个会话一个文件
    ├── traces/<id>.json
    └── long_term_memory.json
```

---

## 4. 核心模块详解

### 4.1 ConductorAgent（`src/agents/conductor.js`）

主对话 Agent，每次调用 `respond({ sessionId, userMessage, ... })` 等价于：

```
1) sessionManager.appendMessage(sessionId, { role:'user', content })
2) loop (最多 maxSteps 次):
     messages = sessionManager.get(sessionId).messages   ← 总是用最新历史
     response = llm.stream(system, messages, tools)      ← 边出边推 token 事件
     append assistant message (含 tool_calls if any)
     if 没有 tool_calls: break
     for each tool_call:
        result = toolRegistry.invoke(call.name, call.input, { trace, tracer, ... })
        append tool message
3) emit turn:done
```

与 BaseAgent 的本质区别：

| | BaseAgent | ConductorAgent |
| --- | --- | --- |
| 用途 | 一次性任务（researcher / coder / reviewer） | 持续对话（与用户交互） |
| Memory | 内部 ShortTermMemory，每次 run 清空 | 从 SessionManager 加载，写回持久化 |
| 输入 | 一个 prompt 字符串 | userMessage + sessionId |
| 工具 | 受限子集（按 role） | 全部工具 + delegate_to_* |

### 4.2 Agent as Tool（`src/tools/delegate.js`）

把任意子 Agent 包装成 Conductor 可调用的 JSON Schema 工具：

```js
makeDelegateTool({
  name: 'delegate_to_researcher',
  description: '...',
  agent: researcher,           // 一个 BaseAgent 实例
  longTermMemory,              // 子 Agent 完成后自动沉淀结论
})
```

工具 handler 内部：
```js
async ({ goal, context }, ctx) => {
  const result = await agent.run({
    input: `${goal}\n\n参考背景：\n${context || ''}`,
    trace: ctx.trace,            ← 透传，让 trace 自然嵌套
    tracer: ctx.tracer,
    parentSpanId: ctx.parentSpanId,
    stream: false,               ← 子 Agent 不直接对外流（避免 token 混线）
  });
  return { agent: agent.name, result: result.content, usage: result.usage };
}
```

为什么这么设计：

- **主 Agent 看到的世界很简单**：只有"工具"，没有专门的 sub-agent 协议
- **Trace 嵌套自然**：tool span(delegate) → agent span(子 Agent) → llm/tool span...
- **任何子 Agent 都可以这样接入**，零特殊处理
- **正是 Claude Code / Codex 的实现方式**

### 4.3 SessionManager（`src/core/session.js`）

```js
class SessionManager {
  create({ title })          → { id, title, messages: [], ... }
  get(id)                    → session | null
  list()                     → [{ id, title, createdAt, messageCount }, ...]
  appendMessage(id, msg)     → 追加并 _save，首条 user 消息自动当 title
  rename(id, title)
  delete(id)
}
```

落盘到 `data/sessions/<id>.json`。每条消息形态与 AISDKProvider 期望完全一致：

```js
{ role:'user',      content:string,                                     meta: { createdAt } }
{ role:'assistant', content:string, toolCalls?:[{id,name,input}],       meta: { id, usage } }
{ role:'tool',      toolCallId, toolName, content:string,               meta: { createdAt } }
```

`meta` 是 UI/observability 用的，传给 LLM 前会被 `stripMeta` 去掉。

### 4.4 工具系统

注册时声明 `allowedAgents`，做权限隔离：

| 工具 | conductor | researcher | coder | reviewer |
| --- | :-: | :-: | :-: | :-: |
| calculator | ✓ | ✓ | ✓ | ✓ |
| web_search | ✓ | ✓ | | |
| file_system_read | ✓ | | ✓ | ✓ |
| file_system_write | ✓ | | ✓ | |
| delegate_to_researcher | ✓ | | | |
| delegate_to_coder | ✓ | | | |
| delegate_to_reviewer | ✓ | | | |

Conductor 拿到全集（包括 delegate）；子 Agent 拿到内部工具但**不能**互相 delegate（避免无限递归）。

### 4.5 LLM Provider 抽象层（`src/llm/`）

| 实现 | 适用 |
| --- | --- |
| `AISDKProvider` | 所有真实模型，统一走 Vercel AI SDK v6 |
| `MockProvider` | 无 API Key 时的离线 fallback（含 conductor / researcher / coder / reviewer 剧本） |

`AISDKProvider` 内部按 provider 名做协议分流：

| Provider | SDK 包 | 实际端点 |
| --- | --- | --- |
| anthropic | `@ai-sdk/anthropic` | Anthropic Messages API |
| openai | `@ai-sdk/openai` 的 `.chat()` | OpenAI Chat Completions |
| deepseek | `@ai-sdk/openai-compatible` | DeepSeek Chat Completions |

> **重要**：v6 的 `@ai-sdk/openai` **默认走 Responses API**（新接口），DeepSeek/通义/智谱等第三方都不支持。
> 接入任何第三方 OpenAI 兼容厂商一律用 `@ai-sdk/openai-compatible`，**不要**用 `createOpenAI({ baseURL })`。

`AISDKProvider.stream()` 内置防御：
- 流式返回空体（DeepSeek 偶发）→ 自动 fallback 到非流式 `chat()`
- `AI_NoOutputGeneratedError` / 流提前关闭 → 同样 fallback

### 4.6 事件协议（`src/streaming/sse.js`）

| 事件 | 触发 | payload |
| --- | --- | --- |
| `message:user` | 用户消息已入库 | `{ sessionId, content }` |
| `message:start` | LLM 开始生成一条 assistant 消息 | `{ sessionId, id, role:'assistant' }` |
| `message:token` | 流式 token | `{ sessionId, id, chunk }` |
| `message:end` | 一条 assistant 消息完成 | `{ sessionId, id, content, toolCalls, usage }` |
| `tool:start` / `tool:end` / `tool:error` | 工具调用 | `{ sessionId, toolCallId, name, input/result/error }` |
| `delegate:done` | delegate 工具完成 | `{ agent, summary }` |
| `turn:done` | 整轮完成（无更多 tool_call） | `{ sessionId, usage, steps }` |
| `turn:error` | 整轮失败 | `{ sessionId, error }` |

Web UI 把这 9 类事件一对一映射成 DOM 操作；CLI 把它们打到 stdout。**同一套事件，不同消费**——这是 bus 解耦的价值。

---

## 5. 关键时序图

### 5.1 一次完整 turn（用户在 Web UI 输入数学题）

```
Browser            HTTP            Conductor          ToolRegistry      LLM
  │   EventSource   │                  │                    │             │
  ├─►/sessions/:id/stream?message=...                                       │
  │                 ├──── respond()────►                                    │
  │                 │                  │ appendMessage(user, "...")         │
  │                 │   message:user  │                                    │
  │◀────────────────│                  │                                    │
  │                 │                  ├──── llm.stream(history, tools)────►│
  │   message:start │                  │                                    │
  │◀────────────────│                  │◀── token chunks ───────────────────│
  │   message:token │                  │                                    │
  │◀────────────────│                  │                                    │
  │   message:end (with toolCalls=[calculator])                              │
  │◀────────────────│                  │ append assistant message           │
  │                 │                  │                                    │
  │                 │                  ├──invoke('calculator', ...)─────►   │
  │   tool:start    │                  │                    │ exec         │
  │◀────────────────│                  │                    │ → 624        │
  │   tool:end      │                  │◀───────────────────│              │
  │◀────────────────│                  │ append tool message                │
  │                 │                  │                                    │
  │                 │                  ├──── llm.stream(...history+tool)──►│
  │   message:start │                  │                                    │
  │◀────────────────│                  │◀── tokens "结果是 **624**..." ─────│
  │   message:token │                  │                                    │
  │◀────────────────│                  │                                    │
  │   message:end (toolCalls=[])                                            │
  │◀────────────────│                  │                                    │
  │   turn:done     │                  │                                    │
  │◀────────────────│                  │                                    │
```

### 5.2 复杂任务（调研 + 写文件 + 审查）

Conductor 自主决定一连串 `delegate_*` 调用，工具内部启动子 Agent，子 Agent 又调自己的工具：

```
Conductor.llm 决定 toolCalls=[delegate_to_researcher]
  └─ delegate_to_researcher
       └─ Researcher Agent ReAct
            ├─ llm → toolCalls=[web_search]
            ├─ web_search → 命中条目
            └─ llm → 调研结论
       ←── 返回 { result: "..." }
  ←── tool result 写回 Conductor.session

Conductor.llm 决定 toolCalls=[delegate_to_coder]
  └─ delegate_to_coder
       └─ Coder Agent ReAct
            ├─ llm → toolCalls=[file_system_write]
            ├─ file_system_write → ok
            └─ llm → 完成报告

Conductor.llm 决定 toolCalls=[delegate_to_reviewer]
  └─ delegate_to_reviewer
       └─ Reviewer Agent ReAct
            ├─ llm → toolCalls=[file_system_read]
            ├─ file_system_read → 文件内容
            └─ llm → 评分 + 建议

Conductor.llm → 综合给最终回复 → 流式推
```

整条链上**所有 span 都嵌套在同一个 trace 里**，可以在 `/traces/:id` 看到完整树。

---

## 6. HTTP 接口

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/health` | 健康检查 + 当前 provider |
| POST | `/sessions` | 创建新会话 |
| GET | `/sessions` | 会话列表（轻量信息） |
| GET | `/sessions/:id` | 会话详情（含完整 messages） |
| PATCH | `/sessions/:id` | 重命名 |
| DELETE | `/sessions/:id` | 删除 |
| GET | `/sessions/:id/stream?message=...&provider=...` | **SSE 流，追加用户消息并触发 Conductor 响应** |
| GET | `/traces` / `/traces/:id` | trace 列表 / 详情 |
| GET | `/memory` / `/memory/search?q=` | 长期记忆 |

---

## 7. 扩展点

| 需求 | 改哪里 |
| --- | --- |
| **加一个新子 Agent**（比如 Translator） | 在 `src/agents/` 复制 `researcher.js`，在 `src/tools/index.js` 的 `buildToolRegistryWithSubAgents()` 里 `makeDelegateTool({ name:'delegate_to_translator', agent: translator })` |
| **加一个新工具** | 在 `src/tools/` 加 `*.js`，在 `tools/index.js` register；设 `allowedAgents` |
| **接入真实搜索 API** | 替换 `tools/webSearch.js` 的 `handler`（对接 Tavily / Serper / Bing） |
| **接入向量长期记忆** | 改 `memory/longTerm.js` 的 `search()`：换成 embedding + cosine |
| **支持新 LLM Provider** | 在 `aisdk.js` 的 `createAISDKModel` 加 `case`。第三方 OpenAI 兼容厂商一律用 `@ai-sdk/openai-compatible`，**不要**用 `createOpenAI` 配 baseURL（v6 默认 Responses API，绝大多数第三方不支持） |
| **多用户隔离** | `SessionManager` 加 `userId` 维度，文件路径变 `data/sessions/<userId>/<id>.json` |
| **生产级 Trace** | 把 `tracer.js` 内部改成 OpenTelemetry SDK，落 Jaeger / Tempo |
| **失败重试 / 兜底模型** | 在 `BaseAgent.run()` 或 `Conductor.respond()` 的 LLM 调用外加 retry；fallback provider 已在 `AISDKProvider.stream()` 内置 |
| **每条消息支持图片/文件** | `Session` 消息结构里加 `attachments`，转成 AI SDK 的 `UserContent` 多模态 part |

---

## 8. 安全与边界

| 风险 | 缓解措施 |
| --- | --- |
| LLM 让 `file_system_write` 写出沙箱 | `tools/fileSystem.ts`：`path.relative` 越界检查（兼容大小写不敏感 FS） + denylist（`.env / .git / package.json`） + allowlist（默认 `data/ tmp/ output/`） |
| `calculator` 被注入任意 JS | 入参正则白名单 `[\d\s+\-*/().]` + 长度 cap 256 + 数字字面量 cap 32 + `Number.isFinite` 校验 |
| 工具滥用（reviewer 改文件） | `allowedAgents` 白名单 |
| 子 Agent 无限递归 | delegate 工具仅 conductor 可见，子 Agent 无 delegate 权限 |
| 长上下文爆炸 | session messages 当前不做压缩；可在 ConductorAgent 加滑动窗口 + 摘要压缩 |
| 流式空体（DeepSeek 等） | `AISDKProvider.stream()` 自动 fallback 到 `chat()` |
| API Key 泄漏到日志 | logger 默认只打 provider/model，不打 key |
| **Prompt injection（附件）** | `<user-attachment>` XML tag 包裹抽取文本 + system prompt 加防护语；OCR 长文 60k 字符截断 |
| **MCP 恶意 server 注册 tool** | `trusted: false` 强制 `allowTools` 白名单；命名空间 `mcp__<server>__<tool>` 隔离 |
| **HTTP 层** | Helmet 默认头（CSP / HSTS / X-Frame-Options 等）+ SSE 单 IP 限 8 连接 |
| **LLM tool args 类型错** | `ToolRegistry.invoke` 走 Zod inputSchema 校验，失败抛 `ToolInputError` 转 LLM payload 自修复 |
| **Provider 限流 / outage** | `FallbackLLM` 链 + `withRetry` 指数退避（仅 429 / 5xx / 网络错） |
| **Provider 失控烧账户** | `BudgetGuard` 单会话 / 当日 USD 上限 + 80% 阈值预警 |
| **客户端关页 / Stop 后 tool 仍在跑** | `AbortController` 全链路：Conductor / Tools / MCP `Promise.race` |
| **Git 误提交敏感文件** | `scripts/pre-commit.sh` 拦小红书 / 草稿 / `.env` / `sk-*` 等 |

---

## 9. v0.2 新增章节（路线图 7 项 + 延伸）

### 9.1 Plan-and-Execute

两种模式，由 `config.agent.planAndExecute` + `config.agent.planExplicitSteps` 控制：

**V1（默认 false 不启用，启用即 `AGENT_PLAN_AND_EXECUTE=true`）**：
1. 启发式 `shouldPlan()`（含「然后/接着」类词、编号列表、长文本）筛复杂任务
2. 调 `planTask()` LLM 单次拿回 `Plan = { steps: [{id, description, success_criteria, depends_on}] }`
3. 把 `renderPlanForConductor()` 渲染的 plan 注入 system prompt
4. 继续走原 ReAct 循环

**V2（`AGENT_PLAN_EXPLICIT_STEPS=true`，依赖 V1 也开）**：
1. 同上 1-2 步
2. 走 `_planExecuteSteps`：for-each step
   - emit `plan:step:start` + 注入 `[执行计划 <id>] <description>` user 消息
   - 跑 `_runReactSteps`（per step 限 4 inner steps）
   - emit `plan:step:end` (ok / error / durationMs)
   - **失败 re-plan 一次**：调 `revisePlan()` 拿替代 steps 替换剩余队列，emit `plan:revised`
3. 最后聚合：注入 `[计划执行完成] 各步骤结果如下...` 让 LLM 给最终汇总

`agents/conductor.ts` 把原 while-loop 抽成 `_runReactSteps()`，V1/V2 共享。

### 9.2 Self-Critique（`AGENT_SELF_CRITIQUE=true`）

在 `_runReactSteps` 终答前（没新 tool calls 时）：
1. 调 `_critique()` 用同 LLM + `SELF_CRITIQUE_PROMPT`（temperature=0, maxTokens=256）
2. 输出 `OK` → 通过；`REVISE: ...` → emit `critique:revise`，注入 user 修订请求，回到 while 头继续跑
3. `critiqueDoneRef` 一次会话只跑一次防死循环

### 9.3 Eval Harness（`apps/server/eval/`）

```
runner.ts → loader.ts (yaml + zod) → 跑 conductor → 收 trace → score.ts 断言 → judge.ts (LLM 裁判) → 写 report.json
```

- 任务 yaml：`tasks/<category>/<id>.yaml`，含 `must_call_tool` / `must_not_call_tool` / `final_contains` / `must_not_contain` / `max_steps` / `max_tokens` / `judge_prompt` / `judge_min_score`
- LLM-as-judge：`judge.ts` 调 `LLM_JUDGE_PROVIDER`，要求严格 JSON `{score:0-5, reason}`
- Regression diff：每轮跑完写 `latest-<provider>.json` 当下次 baseline；标 `wasPass && !nowPass` 为回归
- CI 门禁：`--fail-on-regression` 退码 2

### 9.4 Cost & Budget

- `core/budget.ts`：`BudgetGuard` 单例
  - `beforeTurn(sessionId)`：检查 session USD / token / 当日 USD 上限
  - `afterTurn(sessionId, usage, provider, model)`：累加 + 80% 阈值 emit `budget:warn`
- `llm/pricing.ts`：`PRICING_TABLE` 含 4 个 provider × 多 model 单价；`priceFor(provider, model, usage)` 前缀匹配
- `llm/aisdk.ts:_withPromptCache`：Anthropic ≥1024 token system prompt 自动挂 `cacheControl: ephemeral`
- `llm/cache.ts`：`LLMCache`（开发用，`LLM_CACHE=true` 启用），key = hash(provider+model+messages+tools)

### 9.5 Resilience

- `tools/registry.ts`：Zod inputSchema 运行时校验
- `tools/errors.ts`：`ToolInputError.toLLMPayload()` 返回 `{error, tool, issues, receivedInput, hint}` 让 LLM 自修复
- `llm/retry.ts`：`withRetry()` 指数退避 + jitter，`isRetryable` 仅匹配 429 / 5xx / 网络层
- `llm/fallback.ts`：`FallbackLLM` 链，`isProviderOutage` 判断才降级（非内容质量降级）
- `AbortController` 全链路：Conductor `req.on('close')` → `_runReactSteps` 每步前 check `signal.aborted` → ToolCtx 透传 → MCP `callTool` `Promise.race`

### 9.6 RAG / 长期记忆升级

- `llm/embedding.ts`：`EmbeddingProvider` 接口；OpenAI `text-embedding-3-small` / Mock（hash 派生）
- `memory/longTerm.ts`：
  - `remember()` exact sha1 dedup + 异步 `_computeVecAsync`
  - `rememberAsync()` 同步 exact + 向量 cosine ≥0.95 dedup
  - `search()` 关键词 + 向量两个 ranker → `hybridSearch.ts:rrfMerge` 合并
  - `compact({ llm, triggerAt, similarityThreshold })` 超量按 cluster + LLM 合并摘要
  - `_evictIfOver()` 超 `maxEntries` LRU
- `memory/vectorStore.ts`：`VectorStore` 接口 + `InMemoryVectorStore`；sqlite-vec 迁移文档预留

### 9.7 Deployment & Drain

- `Dockerfile`：多阶段，pnpm filter 只装 server deps；内置 HEALTHCHECK
- `docker-compose.yml`：data/ 挂卷 + `stop_grace_period: 35s`
- `config.ts:validateEnvOnBoot()`：Zod 校验 PORT / LLM_PROVIDER / 各 API key（按 provider 必填）；boot 期挂
- `server.ts`：
  - `/health` 活探针；`/ready` 跑 env + 数据目录可写 + MCP 连接 三检查
  - `drainer` 跟踪 in-flight turn count；SIGTERM 时 `server.close()` + 等 ≤30s + 关 MCP
  - 中间件：drain 期间所有非 `/health` 请求返 503

### 9.8 Skills/MCP 翻译

- `skills/loader.ts` 扫盘新增软链跟随（`fs.statSync` 而非 `dirent.isDirectory`）+ `~/.claude/plugins/marketplaces/` 路径
- `skills/translator.ts`：
  - 单 skill 翻译落 `data/skills-zh/<sanitized>.<lang>.md`（frontmatter + body）
  - 列表名 batch 翻译落 `_names.<lang>.json`
  - `sourceHash` 校验：原文变了自动 invalidate
- `mcp/translator.ts`：tool desc + 短中文显示名 batch；落 `data/mcp-zh/<server>.<lang>.json`

### 9.9 Trace Replay + A/B

- `POST /traces/:id/replay`
  - body `{provider}`：单 replay，向后兼容
  - body `{providers: string[]}`：多 provider 并发 replay，返 `{replays: [{replayTraceId, provider, error?}]}`
- 每个 replay fork 独立 forked session + tracer.startTrace('conductor.replay', {replayOf})
- 前端 `traces/page.tsx:ABComparePanel` 拉每个 replay 完整 trace 平铺对比 totals / final answer

### 9.10 SSE 事件协议（v0.2 新增）

原协议见 §4.6；新增：

| 事件 | payload | emit 时机 |
| --- | --- | --- |
| `critique:revise` | `{sessionId, critique}` | self-critique 输出 `REVISE:` |
| `critique:ok` | `{sessionId}` | self-critique 输出 `OK` |
| `budget:warn` | `{scope, sessionId?, usd, cap, ratio}` | 累计达 80% 上限 |
| `review:needed` | `{sessionId, files: string[]}` | 本轮写了代码文件（auto-review） |
| `plan:created` | `{sessionId, plan: {steps}}` | Planner 返回 plan |
| `plan:step:start` | `{sessionId, stepId, description}` | V2 模式每步开始 |
| `plan:step:end` | `{sessionId, stepId, ok, durationMs, finalContent}` | V2 每步结束 |
| `plan:revised` | `{sessionId, failedStepId, reason, newSteps}` | step 失败触发 re-plan |

---

## 10. 已知限制（更新）

1. **Session 历史无压缩**：长对话会持续增长 tokens，到达模型上下文上限会失败。生产应加摘要压缩或滑动窗口。
2. **VectorStore 是 InMemory**：> 10k 条目时该上 sqlite-vec（迁移文档 `docs/agent-roadmap/sqlite-vec-migration.md` 已就绪）。
3. **delegate 工具无法并发**：当前顺序执行 toolCalls；如果模型一次发多个 delegate，会串行。
4. **Web UI 无身份认证**：本地 demo 用，公网部署需加 auth + per-user session 隔离。
5. **Mock Provider 是剧本化**，不能完全替代真实 LLM 的语义判断；eval 任务 expect 也是按 mock 写的，切真 provider 需要 task variants（用 `judge_prompt` 替代 `final_contains`）。
6. **BudgetGuard 不持久化**：重启进程后会话累计归零；生产环境应换 Redis / KV。
7. **Plan-and-Execute V2 串行**：steps 内部都顺序跑，没有并行优化；并行需要 step `depends_on` 分析 + 调度器。
8. **真 LLM eval baseline 还没建立**：当前 `latest-<provider>.json` 全是 mock；要建议照 `docs/agent-roadmap/eval-real-llm-workflow.md` 跑一次。

---

## 11. 文件与代码导航（v0.2 更新）

> 文件后缀全部 `.ts`（tsx 直跑）；老的 `.js` 标注已迁。

**核心**

| 想看什么 | 打开哪个文件 |
| --- | --- |
| 入口（HTTP） | `src/server.ts` |
| 入口（CLI 对话） | `src/cli.ts`（已 init MCP + skills） |
| 主对话循环 + plan-execute V1/V2 + self-critique | `src/agents/conductor.ts` |
| 单次任务 ReAct 循环（sub-agent 基类） | `src/agents/base.ts` |
| 子 Agent 怎么变成工具 | `src/tools/delegate.ts` |
| 工具权限怎么隔离 + Zod 校验 + 自修复 | `src/tools/registry.ts` + `tools/errors.ts` |
| Planner / RevisePlan / shouldPlan | `src/agents/planner.ts` |
| 会话怎么存的 | `src/core/session.ts` |
| 怎么调 Claude / OpenAI / DeepSeek | `src/llm/aisdk.ts`（含 Anthropic prompt cache） |
| Provider fallback 链 | `src/llm/fallback.ts` |
| 不联网怎么跑通 demo | `src/llm/mock.ts` |
| 事件协议全集 | `src/streaming/sse.ts`（含 v0.2 新增 8 个事件） |

**v0.2 新增**

| 想看什么 | 打开哪个文件 |
| --- | --- |
| Eval Harness | `eval/runner.ts` + `loader.ts` + `score.ts` + `judge.ts` |
| Eval 任务 | `eval/tasks/<category>/*.yaml` |
| Budget 守卫 | `src/core/budget.ts` |
| 单价表 | `src/llm/pricing.ts` |
| LLM 响应缓存 | `src/llm/cache.ts` |
| Retry + 指数退避 | `src/llm/retry.ts` |
| Embedding（OpenAI/Mock） | `src/llm/embedding.ts` |
| 长期记忆（dedup + compact + RAG） | `src/memory/longTerm.ts` |
| 混合检索 RRF | `src/memory/hybridSearch.ts` |
| VectorStore 接口 | `src/memory/vectorStore.ts` |
| Graceful drain | `src/core/drain.ts` |
| Boot 期 env 校验 | `src/config.ts:validateEnvOnBoot` |
| Self-critique prompt | `src/prompts/selfCritique.ts` |
| Skills 扫盘（含软链 + plugins） | `src/skills/loader.ts` |
| Skills 翻译 | `src/skills/translator.ts` |
| MCP 信任边界 + reconnect | `src/mcp/manager.ts` |
| MCP 翻译 | `src/mcp/translator.ts` |
| Trace Replay（含 A/B 多 provider） | `src/server.ts:/traces/:id/replay` |

**前端**

| 想看什么 | 打开哪个文件 |
| --- | --- |
| Web 主入口 | `apps/web/src/app/page.tsx` |
| `/skills` 管理页 | `apps/web/src/app/skills/page.tsx` |
| `/mcp` 管理页 | `apps/web/src/app/mcp/page.tsx` |
| `/traces` + Replay UI | `apps/web/src/app/traces/page.tsx` |
| 输入框 + `/` slash 命令 | `apps/web/src/components/Composer.tsx` + `SlashMenu.tsx` |
| 虚拟滚动 | `apps/web/src/components/VirtualList.tsx` |
| Notice 浮层（budget/critique/review/plan） | `apps/web/src/components/ChatNotices.tsx` |
| SSE 流消费 + rAF batching | `apps/web/src/hooks/useChat.ts` |

**文档**

| 想看什么 | 打开哪个文件 |
| --- | --- |
| 「想做 X 改哪里」一键查 | `STRUCTURE.md` |
| 路线图 7 项设计文档 | `docs/agent-roadmap/01-...07-*.md` |
| 真 LLM eval workflow | `docs/agent-roadmap/eval-real-llm-workflow.md` |
| sqlite-vec 迁移 | `docs/agent-roadmap/sqlite-vec-migration.md` |
