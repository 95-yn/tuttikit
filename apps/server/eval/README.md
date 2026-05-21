# Eval Harness

> 给 TuttiKit 的 golden task set 评测框架。详细设计见 [`docs/agent-roadmap/01-eval-harness.md`](../../../docs/agent-roadmap/01-eval-harness.md)。

## 跑

```bash
# 所有任务，mock provider（CI 门禁用，不烧 API）
pnpm -C apps/server eval

# 只跑某分类
pnpm -C apps/server eval --filter=math
pnpm -C apps/server eval --filter=research

# 精确单条
pnpm -C apps/server eval --filter=math-001-basic-add

# 跑真模型（要 .env 配 API key）
pnpm -C apps/server eval --provider=anthropic
pnpm -C apps/server eval --provider=openai --filter=math

# 并发（仅 mock 安全；真模型小心限流）
pnpm -C apps/server eval --concurrency=4

# 看完整日志
LOG_LEVEL=info pnpm -C apps/server eval
```

退出码：`0` = 全 pass；`1` = 有 fail / error，CI 门禁直接用。

## 任务格式

`tasks/<category>/<id>.yaml`：

```yaml
id: math-001-basic-add          # 全局唯一
category: math                  # 分类（决定 --filter）
tags: [calculator, single-tool]
input: "帮我算 1 + 2 + 3"        # 喂给 Conductor 的 user message
attachments: []                  # 可选：路径相对 apps/server
expect:
  must_call_tool: calculator     # 必须调过的工具（可为字符串或数组）
  must_not_call_tool:            # 不允许调用的工具
    - file_system_write
  final_contains: ["6"]          # 终答案必须含的片段（数组）
  must_not_contain: ["抱歉"]      # 终答案不能含的片段（数组）
  max_steps: 3                   # ReAct 步数上限
  max_tokens: 5000               # in+out token 上限
  judge_prompt: ""               # LLM-as-judge prompt（Phase 1B，目前会被跳过）
  judge_min_score: 3             # judge 通过分（同上）
```

任一 `expect` 断言失败 → 任务 fail。

## 报表

每轮跑完写两份 JSON 到 `data/eval-runs/`：

- `<date>-<provider>-<seq>.json` —— 本轮快照（用 trace + assertions 还原现场）
- `latest-<provider>.json` —— 最近一次同 provider 的结果（下一阶段做 regression diff 用）

报表结构见 `eval/types.ts` 的 `RunReport`。

## 当前还没做（roadmap）

- **LLM-as-judge**：`judge_prompt` 字段会被读但目前跳过；接上之后能给开放性答案打分（[01-eval-harness.md §Layer 2](../../../docs/agent-roadmap/01-eval-harness.md#layer-2lLM-as-judge)）。
- **Regression diff**：拉 `latest-<provider>.json` 做 baseline 对比，CI 加 `--fail-on-regression` 拦回归。
- **更多任务**：当前 10 条覆盖 4 个分类，目标 30-50 条覆盖：multimodal / multi-step / refusal-jailbreak / sub-agent-coordination / mcp-tool。
- **真 LLM 跑通**：当前所有任务的 expect 是按 mock provider 行为写的；切到真模型很多会挂（终答案文本不同）。需要给真 provider 单独维护 task variants 或把断言放宽。
