# 01 · 评测与回归（Eval Harness）

> **核心论点**：没有 eval，所有 prompt / model / tool / 架构调整都是凭感觉。这是 TuttiKit 的最大缺口。

## 现状

- `apps/server/examples/test-*.ts` 共 84 条断言，全是**单元 smoke**（解析器、tool 调用、markdown 渲染）。
- **没有端到端任务集**：给 Conductor 一道题，看它能不能答对。
- **没有跨模型对比**：换 Claude / GPT / DeepSeek 后，质量到底升了还是降了？无从得知。
- **没有回归门禁**：发版前不知道某次改动有没有让某些任务变差。

## 设计

分三层，自下而上：

### Layer 1：Golden Task Set（人工标注的任务库）

`apps/server/eval/tasks/*.yaml`，每条任务一份：

```yaml
id: math-001
category: tool-use
input: "(3 + 5) * 2 - 4 的结果是？"
expect:
  must_call_tool: calculator
  final_contains: ["12"]
  must_not_contain: ["抱歉", "无法"]
  max_steps: 3
  max_tokens: 2000
tags: [calculator, single-tool]
```

约定四种 expect 断言：
- `must_call_tool` —— 必须调用过某 tool（从 trace 里读）
- `final_contains` / `must_not_contain` —— 终答案文本断言
- `max_steps` / `max_tokens` —— 性能上限
- `judge_prompt` —— 交给 LLM-as-judge 给 0-5 分（见 Layer 2）

初版建议覆盖 30-50 条，分类：math / file-ops / web-search / multi-step / multimodal / delegation / refusal。

### Layer 2：LLM-as-Judge

对没有客观答案的任务（"写一段关于 X 的总结"），用裁判 LLM 打分：

```ts
// apps/server/eval/judge.ts
async function judgeAnswer(task, transcript): Promise<{score:number, reason:string}> {
  const prompt = `You are an evaluation judge. Score 0-5.
Task: ${task.input}
Rubric: ${task.judge_rubric}
Answer:\n${transcript.final}
Return JSON {score, reason}.`;
  // 用 mock provider 跑测试时跳过 judge，真跑 eval 才调用
}
```

约定 score ≥ 3 视为通过。

### Layer 3：Runner + 报表

```bash
pnpm -C apps/server eval --provider=anthropic --tasks=math/* --concurrency=4
```

输出 `apps/server/data/eval-runs/<run-id>/report.json`：

```json
{
  "runId": "2026-05-20-anthropic",
  "provider": "anthropic",
  "totals": { "pass": 42, "fail": 6, "skipped": 2 },
  "byCategory": { "math": "10/10", "file-ops": "8/10" },
  "regressions": [{ "id": "math-007", "wasPass": true, "now": "fail", "diff": "..." }],
  "perTaskCost": { "math-001": { "tokensIn": 220, "tokensOut": 90, "usd": 0.0021 } }
}
```

**回归检测**：runner 拉上一次 `report.json`（按 provider 区分），列出 `wasPass && now==fail` 的任务，CI 里 `--fail-on-regression` 直接挂。

## 改哪些文件

新增：

- `apps/server/eval/tasks/*.yaml` —— 任务集（约 30 条起步）
- `apps/server/eval/runner.ts` —— 入口，扫 tasks、调用 conductor、收集 trace、写 report
- `apps/server/eval/judge.ts` —— LLM-as-judge
- `apps/server/eval/score.ts` —— must_call_tool / final_contains 这类断言执行器
- `apps/server/package.json` —— 加 `"eval": "tsx eval/runner.ts"` 脚本

复用：

- `apps/server/src/observability/tracer.ts` —— runner 直接读 trace 判断 must_call_tool
- `apps/server/src/agents/index.ts` —— runner 拿 Conductor 单例跑

## 验收

1. `pnpm -C apps/server eval --provider=mock` 全绿（验证 runner 自身正确）。
2. `pnpm -C apps/server eval --provider=anthropic --tasks=math/*` 真跑，输出 report。
3. 报表里能看到每条任务的 trace 链接（`<base>/traces/<id>`），点开能复现。
4. 第二次跑同样命令时，能识别上一次的 baseline 并列出 diff。

## 上线建议

- **PR 门禁**：CI 里加 `pnpm eval --provider=mock`，确保 runner 本身不挂；不在 CI 里跑真 LLM（贵且不稳定）。
- **夜间跑**：本地 cron 或 GitHub Actions 定时（每天 02:00）跑真 provider，结果发飞书 / Slack。
- **不要追求 100% 通过率**：保留几个故意失败的任务（refusal 类、刁钻问法），用来观察模型变化。
