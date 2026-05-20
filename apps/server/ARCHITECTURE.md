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
| LLM 让 `file_system_write` 写出沙箱 | `tools/fileSystem.js` 强制 `path.resolve(ROOT, p).startsWith(ROOT)` |
| `calculator` 被注入任意 JS | 入参正则白名单 `[\d\s+\-*/().]` |
| 工具滥用（reviewer 改文件） | `allowedAgents` 白名单 |
| 子 Agent 无限递归 | delegate 工具仅 conductor 可见，子 Agent 无 delegate 权限 |
| 长上下文爆炸 | session messages 当前不做压缩；可在 ConductorAgent 加滑动窗口 + 摘要压缩 |
| 流式空体（DeepSeek 等） | `AISDKProvider.stream()` 自动 fallback 到 `chat()` |
| API Key 泄漏到日志 | logger 默认只打 provider/model，不打 key |

---

## 9. 已知限制

1. **Session 历史无压缩**：长对话会持续增长 tokens，到达模型上下文上限会失败。生产应加摘要压缩或滑动窗口。
2. **长期记忆是关键词检索**，不是向量。
3. **delegate 工具无法并发**：当前顺序执行 toolCalls；如果模型一次发多个 delegate，会串行。
4. **Web UI 无身份认证**：本地 demo 用，公网部署需加 auth + per-user session 隔离。
5. **Mock Provider 是剧本化**，不能完全替代真实 LLM 的语义判断。

---

## 10. 文件与代码导航

| 想看什么 | 打开哪个文件 |
| --- | --- |
| 入口（HTTP） | `src/server.js` |
| 入口（CLI 对话） | `src/cli.js` |
| 主对话循环 | `src/agents/conductor.js` |
| 单次任务 ReAct 循环 | `src/agents/base.js` |
| 子 Agent 怎么变成工具 | `src/tools/delegate.js` |
| 工具权限怎么隔离 | `src/tools/index.js`（`allowedAgents`） |
| 会话怎么存的 | `src/core/session.js` |
| 怎么调 Claude / OpenAI / DeepSeek | `src/llm/aisdk.js` |
| 不联网怎么跑通 demo | `src/llm/mock.js` |
| 事件协议全集 | `src/streaming/sse.js`（注释中） |
| Web UI 渲染逻辑 | `public/app.js` |
