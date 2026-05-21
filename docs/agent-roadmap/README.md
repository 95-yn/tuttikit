# TuttiKit · Agent Fundamentals 路线图

> 参照业界 "Agent Fundamentals" 类课程的标准章节（ReAct / Tool Use / Memory & RAG / Planning & Reflection / Evaluation / Cost / Safety / Resilience / Deployment），对当前 TuttiKit 做现状盘点 + 改进方案。
>
> 用户给的 `sitor.ai/courses/agent-fundamentals` 抓下来是 AI 家教平台落地页、不含真正课纲；故本路线图按通行的 Agent 教学体系组织。

---

## 当前能力盘点

| 能力域 | 状态 | 已有实现 |
| --- | --- | --- |
| **多 Agent 编排** | ✅ | Conductor + Researcher / Coder / Reviewer（Agent as Tool） |
| **工具调用（Tool Use）** | ✅ | calculator / fileSystem / webSearch / delegate_to_* / MCP |
| **多 Provider** | ✅ | Anthropic / OpenAI / DeepSeek / Mock，统一走 Vercel AI SDK |
| **短期记忆** | ✅ | 会话级 message 历史，落盘 `data/sessions/<id>.json` |
| **长期记忆** | ⚠️ 弱 | JSON 文件 + 关键词打分，**无 embedding、无 RAG** |
| **流式（SSE）** | ✅ | 事件总线 → SSE，前端 rAF 批处理（刚优化） |
| **可观测（Trace）** | ✅ | 自建 Trace / Span 树，`/traces` UI |
| **多模态** | ✅ | 图像 + PDF + OCR（tesseract.js / pdf-parse v2） |
| **Skills / MCP** | ✅ | Claude Code 兼容 SKILL.md + MCP stdio/HTTP |
| **安全响应头 + SSE 限流** | ✅ | 刚加（S2） |
| **评测（Eval）** | ❌ | **仅 84 条 smoke 断言**，无 golden set / LLM-as-judge / 回归打分 |
| **Planning / Reflection** | ❌ | 只有 ReAct（maxSteps=10），无 plan-and-execute、无自我反思 |
| **结构化工具 I/O** | ⚠️ | `parameters` 是 JSON Schema 但**未运行时 Zod 校验** LLM 返回的 args |
| **预算 / 速率 / 熔断** | ❌ | 前端有 ctx-meter，**后端无 token 上限、无 retry、无熔断** |
| **Prompt Injection 防护** | ❌ | OCR / PDF 文本直接拼进 prompt，无指令隔离 |
| **LLM 缓存 / Prompt Caching** | ❌ | 每次都走外部 API，未利用 Anthropic prompt cache |
| **Deploy / 健康检查** | ⚠️ | 仅 `/health`，无 Dockerfile、无 env 校验、无 graceful drain |

---

## 七大改进方向（按 ROI 排序）

| # | 主题 | 文档 | 影响 | 估时 |
| --- | --- | --- | --- | --- |
| 1 | **评测与回归（Eval Harness）** | [01-eval-harness.md](./01-eval-harness.md) | 🔴 极高 | 2-3 天 |
| 2 | **RAG 与长期记忆升级** | [02-rag-and-memory.md](./02-rag-and-memory.md) | 🔴 极高 | 2-3 天 |
| 3 | **结构化 I/O + 韧性（Resilience）** | [03-structured-io-and-resilience.md](./03-structured-io-and-resilience.md) | 🟠 高 | 1-2 天 |
| 4 | **Planning & Reflection** | [04-planning-and-reflection.md](./04-planning-and-reflection.md) | 🟠 高 | 2 天 |
| 5 | **成本与预算（含 Prompt Cache）** | [05-cost-and-budget.md](./05-cost-and-budget.md) | 🟡 中高 | 1-2 天 |
| 6 | **安全护栏（Guardrails）** | [06-safety-guardrails.md](./06-safety-guardrails.md) | 🟡 中高 | 1-2 天 |
| 7 | **部署与 Debug**（Dockerfile / Replay / A/B） | [07-deployment-and-debug.md](./07-deployment-and-debug.md) | 🟢 中 | 1-2 天 |

合计约 10-15 个工作日，可分轮迭代。**强烈建议先做 #1 评测**：没有 eval，后续所有改动都没有验收依据。

---

## 阅读建议

- **想立刻动手**：直接看 [01-eval-harness.md](./01-eval-harness.md)，里面给了最小 golden set 的格式 + judge prompt 模板。
- **想了解全貌**：按顺序读完七篇即可，每篇都有 "为什么 / 设计 / 改哪些文件 / 验收"。
- **想跳过设计、直接看代码影响范围**：每篇末尾都有 `## 影响文件` 章节列出绝对路径。

---

## 不在本路线图里的事

下面这些是有意识地排除的，原因写在括号里：

- **完整的多 Agent 协议（A2A / FIPA-ACL 之类）** —— 当前 Agent as Tool 已经足够，引入正式协议是过度设计。
- **自建训练 / 微调流程** —— TuttiKit 是应用框架不是模型训练框架，超出范围。
- **Web 浏览自动化（playwright as tool）** —— 价值高但工作量大，且和 MCP 的 `puppeteer-mcp` 重叠，建议直接接 MCP。
- **完整 RBAC / 多租户** —— 当前单租户够用，引入需要重做整个 session 模型。
