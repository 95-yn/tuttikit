# 真 LLM Eval Workflow

> mock provider 的 eval 主要验证 runner / 断言系统 / 任务 schema。要看一个 prompt / config 改动**真的**有没有让模型变好，需要跑真 provider + LLM-as-judge。本文是落地手册。

## 一、前置条件

```bash
# 至少配一种真 provider 的 API key
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> apps/server/.env
echo 'OPENAI_API_KEY=sk-...'        >> apps/server/.env
echo 'DEEPSEEK_API_KEY=sk-...'      >> apps/server/.env
```

裁判 provider 可以和被测 provider 不同（更客观；推荐 Claude 当 OpenAI 答案的裁判，反之亦然）：

```bash
export LLM_JUDGE_PROVIDER=anthropic       # judge 用 claude
```

## 二、跑一轮真 baseline

**先估预算**。当前 25 条任务，每条约 200-2000 tokens。乘以单价表（见 `apps/server/src/llm/pricing.ts`）：

| Provider | 单轮估价（25 条 × ~1k tokens） |
| --- | --- |
| anthropic claude-sonnet-4 | ~$0.30 |
| openai gpt-4o-mini | ~$0.02 |
| deepseek-chat | ~$0.01 |
| anthropic claude-haiku-4 | ~$0.08 |

判官调用按答案长度 × 单价算，通常和被测同量级（再 ×1）。

**开个低预算确认 budget guard 真生效**：

```bash
BUDGET_SESSION_MAX_USD=2.00 \
BUDGET_DAY_MAX_USD=5.00 \
LLM_JUDGE_PROVIDER=anthropic \
LLM_CACHE=true \
pnpm -C apps/server eval \
  --provider=anthropic \
  --judge-provider=anthropic \
  --concurrency=2
```

跑完报表写到 `apps/server/data/eval-runs/<date>-anthropic-<seq>.json`，同时覆盖 `latest-anthropic.json` 作为下一轮的 baseline。

## 三、解读输出

```
═══════════════════════════════════════════════════════════
总计  23/25 通过 · 2 失败 · 0 异常 · 187320ms
  boundary             3/3
  file-ops             4/4
  math                 7/7
  multi-step           1/2          ← 注意：1 失败
  refusal              4/4
  research             4/5          ← 注意：1 失败
vs baseline 2026-05-20-anthropic-xxx:
  ↓ 回归 1
    ✗ multi-step-001-research-then-write
  ↑ 新通过 0
═══════════════════════════════════════════════════════════
```

- **回归** = 上一次跑 pass，这一次 fail。CI 加 `--fail-on-regression` 退码 2。
- **judge score < min_score** 也算 fail；任务条目里看哪个 assertion 挂的：
  ```
  ✗ research-003-judge-self-intro
       ✗ judge(>=3) — 2/5 · 没提到多 Agent 框架，且超过 3 句
  ```

## 四、A/B 模型对比

不同 provider 用同一份 task set 各跑一次，对比 byCategory 得分：

```bash
for P in anthropic openai deepseek; do
  pnpm -C apps/server eval --provider=$P --judge-provider=anthropic
  cp apps/server/data/eval-runs/latest-$P.json \
     apps/server/data/eval-runs/baseline-$P-$(date +%F).json
done
```

然后用任意 jq / 脚本对比 byCategory：

```bash
jq -r '.byCategory | to_entries | map([.key, "\(.value.pass)/\(.value.total)"] | join("\t")) | .[]' \
  apps/server/data/eval-runs/baseline-anthropic-*.json
```

更"花"的可视化：直接读取 JSON 进 Notion / Google Sheet 画热力图。

## 五、写 judge-style 任务的指南

- **明确 rubric**：rubric 越具体打分越稳。`回答必须包含 X / Y / Z 三个要点；不能含 W`。
- **保留客观断言兜底**：开放性任务也加 `must_call_tool` / `must_not_contain` 防裁判幻觉给个高分但实际答得离谱。
- **min_score 起步给 3**：满分难，3/5 等于"主要要点都覆盖了"。开发改进后再升 4。
- **不要在 rubric 里写"应该简洁"**：每个模型对"简洁"理解不同，会变成裁判主观偏好的噪声。

## 六、节流与省钱

- **`LLM_CACHE=true`**：跑同样 task set 多次 debug 不再付费。eval 跑 N 次只有第一次烧钱。
- **`--concurrency=2`** 是甜点：太高会撞 provider 限流（429 后 retry 反而更慢）。
- **`--filter=math`** 局部跑：改了 calculator prompt 不需要再跑 25 条。
- 半夜跑 + 报飞书机器人：写个 cron，差异显著时再发。

## 七、CI 集成（推荐）

```yaml
# .github/workflows/nightly-eval.yml
on:
  schedule: [{ cron: '0 18 * * *' }]   # 每天 UTC 18:00 = 北京时间 02:00
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - name: Run eval
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          LLM_JUDGE_PROVIDER: anthropic
        run: |
          pnpm -C apps/server eval \
            --provider=anthropic --judge-provider=anthropic \
            --fail-on-regression
      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          path: apps/server/data/eval-runs/latest-anthropic.json
```

## 八、常见坑

- **judge JSON 解析失败**：模型偶尔加 ```json ``` 包裹；`judge.ts` 已自动去掉。如果仍频繁失败，把 judge_prompt 写得更明确"输出严格 JSON"。
- **mock provider 行为漂移**：任务断言假设 mock 的剧本不变；改 mock 会导致 mock 跑挂——这是好事，强制 mock + 真任务同步。
- **同一 provider 二次跑分数小幅波动**：LLM 本质非确定。temperature=0 也只缩小不消除；同任务跑 3 次取中位数更稳。
- **budget guard 误伤批量跑**：`BUDGET_DAY_MAX_USD` 默认 $20，跑全 25 条 ×3 provider 可能就摸到。eval 跑前 export 高一点的上限。
