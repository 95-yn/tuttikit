# 04 · Planning & Reflection

> **核心论点**：当前 Conductor 是纯 ReAct（每步只能看到上一步），复杂任务里很快迷失。Plan-and-Execute + Reflexion 是经典升级。

## 现状

`apps/server/src/agents/conductor.ts` 的循环：

```ts
for (let step = 0; step < maxSteps; step++) {
  const { content, toolCalls } = await llm.streamChat(messages, tools);
  if (!toolCalls.length) break;
  // 执行 tool，把结果塞回 messages
}
```

特点：
- **无显式规划**：每一步靠 LLM 看历史现想，长任务（10+ tool call）会偏题。
- **无反思**：tool 报错就报错，最终答案不好就不好，没人检查。
- **Reviewer agent 形同摆设**：它只在 LLM 主动调 `delegate_to_reviewer` 时才被叫，大部分对话根本不会触发。

## 设计

### A. Plan-and-Execute 模式（可选模式，不替换 ReAct）

加一个 "complex" 路由：用户消息进来后先过一个 router prompt 判断复杂度：

```ts
type RouteDecision = 'react' | 'plan_and_execute';
async function route(userMessage, history): Promise<RouteDecision> {
  // 简单规则 + 廉价模型（haiku / mock）做一次分类
  // 信号：消息长度、关键词（先...然后...最后 / step by step / 分几步）、用户附件数
}
```

判定 `plan_and_execute` 时走 Planner → Executor → Reflector 三步：

```
┌──────────┐    plan     ┌──────────┐
│ Planner  ├────────────▶│ Executor │  per-step ReAct
└──────────┘             └────┬─────┘
      ▲                       │
      │ revise              done│
      │                       ▼
┌──────────┐              ┌────────────┐
│ Reflector├◀─────────────│ Aggregator │
└──────────┘   bad        └────────────┘
```

#### A.1 Planner

输入：user message + history。
输出：JSON `{ steps: [{ id, description, depends_on, success_criteria }] }`。
关键：每个 step 自带 `success_criteria`，给 Reflector 用。

#### A.2 Executor

对每个 step 跑 mini-ReAct（maxSteps=5），输出 `stepResult`。

#### A.3 Reflector

每个 step 完成后调一次 Reviewer 判断 `success_criteria` 是否满足：

```ts
const verdict = await reviewer.review({
  task: step.description,
  criteria: step.success_criteria,
  output: stepResult,
});
if (verdict.score < 3) {
  // 反馈塞回 Planner，触发 revise（限 1 次，防死循环）
}
```

### B. 隐式反思（Self-Critique，零侵入升级）

不引入新 agent，只在 Conductor 终答前加一个 self-check step：

```ts
// 主循环结束、即将返回最终 content 前
const critique = await llm.streamChat([
  { role: 'system', content: SELF_CRITIQUE_PROMPT },
  { role: 'user', content: `Task: ${userMessage}\nDraft answer: ${draftAnswer}` },
], []);
if (critique.startsWith('REVISE:')) {
  // 把 critique 当 user message 塞回去再跑一轮
} else {
  // 直接发
}
```

- 用最便宜的模型（haiku / mock）做 critique，cost 几乎可忽略。
- 默认关闭，通过 `conductor.selfCritique=true` 开启。
- eval harness 里 A/B 对比开 / 关时的得分差。

### C. Reviewer agent 真正接入

现在 Reviewer 只在 LLM 主动 delegate 时触发。改成两个触发点：

1. **Code-writing 任务自动 review**：检测到 `file_system_write` 调用了 `.ts` / `.py` / `.js` 文件 → end-of-turn 自动 review。
2. **High-stakes 任务自动 review**：用户消息里含 "正式 / 发布 / 上线 / 部署" 等关键词 → 强制 review。

```ts
// apps/server/src/agents/conductor.ts 主循环结束后
if (shouldAutoReview(session, toolCalls)) {
  await reviewer.review({ session, draft: draftAnswer });
}
```

## 改哪些文件

新增：
- `apps/server/src/agents/router.ts` —— 复杂度判定
- `apps/server/src/agents/planner.ts` —— 计划生成
- `apps/server/src/agents/aggregator.ts` —— step 结果合并
- `apps/server/src/prompts/selfCritique.ts`
- `apps/server/src/prompts/planner.ts`

改：
- `apps/server/src/agents/conductor.ts` —— 加 router 分发 + selfCritique hook
- `apps/server/src/agents/reviewer.ts` —— `review()` 方法签名
- `apps/server/src/config.ts` —— `agent.planAndExecute`、`agent.selfCritique`、`agent.autoReview` 开关

前端：
- `apps/web/src/components/MessageBubble.tsx` —— 渲染 plan 阶段的 "📋 计划" / "🔍 反思" 子块（沿用 ToolBlock 折叠 UI）。
- `apps/web/src/hooks/useChat.ts` —— 监听新事件 `plan:created` / `plan:step:done` / `critique:result`。
- `apps/server/src/streaming/sse.ts` —— 透传新事件。

## 验收

1. 复杂任务 "帮我把 OVERVIEW.md 翻译成英文然后写到 OVERVIEW_EN.md，并在 README 加一个语言切换链接" → router 判断为 plan_and_execute → trace 里能看到 plan + 3 个 step + reflection。
2. `agent.selfCritique=true` 时，eval harness 长答案任务平均得分提升（要先有 [eval](./01-eval-harness.md)）。
3. 写代码任务自动 review，review 评分 < 3 时前端有 "⚠️ Reviewer 建议修改" 提示，可点开看建议。

## 风险

- **延迟翻倍**：plan-and-execute 比 ReAct 慢 1-2x。**对策**：只对真正复杂的任务路由过去，简单任务保持 ReAct。
- **plan 死循环**：Reflector revise 上限 1 次（写死，不可配）。
- **eval 不充分时不要默认开启**：所有变更都靠 [01-eval-harness.md](./01-eval-harness.md) 验证不退化。
