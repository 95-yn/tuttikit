/**
 * Plan-and-Execute (V1) 测试：
 *   - shouldPlan 启发式正负样本
 *   - planTask 解析合法 / 非法 JSON
 *   - renderPlanForConductor 输出格式
 *
 * 不调真 LLM：用一个 stub LLMLike 返回预设响应。
 */
process.env.LOG_LEVEL ??= 'warn';

import {
  shouldPlan, planTask, revisePlan, renderPlanForConductor, type Plan,
} from '../src/agents/planner.js';
import type { LLMLike, LLMCallArgs, LLMResponse } from '../src/types.js';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// ───── A. shouldPlan 启发式 ─────
{
  // 不该规划的
  assert(!shouldPlan(''), '空 → 不规划');
  assert(!shouldPlan('hi'), 'hi → 不规划');
  assert(!shouldPlan('你好啊朋友'), '短闲聊 → 不规划');
  assert(!shouldPlan('算一下 (1+2)*3'), '单一动作 → 不规划');
  assert(!shouldPlan('什么是 RAG'), '简单问 → 不规划');

  // 应该规划的
  assert(shouldPlan('先调研 pgvector，然后写到 data/pgvector.md'), '"先...然后..." → 规划');
  assert(shouldPlan('帮我做这件事：1. 调研 X；2. 写报告；3. 总结'), '编号列表 → 规划');
  assert(shouldPlan('请你研究下 transformer 架构，接着生成一个 demo.py 文件'),
    '"接着..." → 规划');
  assert(shouldPlan('这是个挺复杂的任务，要先收集资料，再整理成结构化的报告，最后写到文件里供后续查阅，请按步骤来'),
    '长 + 多段 → 规划');
}

// ───── B. planTask 解析 ─────
class StubLLM implements LLMLike {
  name = 'stub';
  reply: string;
  constructor(reply: string) { this.reply = reply; }
  async chat(_args: LLMCallArgs): Promise<LLMResponse> {
    return {
      role: 'assistant', content: this.reply, toolCalls: [],
      usage: { inputTokens: 50, outputTokens: 50 },
    };
  }
  async stream(args: LLMCallArgs): Promise<LLMResponse> { return this.chat(args); }
}

{
  // 合法 JSON
  const validJson = `{
  "steps": [
    {"id": "s1", "description": "调研 X", "success_criteria": "拿到至少 2 篇资料"},
    {"id": "s2", "description": "写到 data/x.md", "success_criteria": "文件存在", "depends_on": ["s1"]}
  ]
}`;
  const plan = await planTask(new StubLLM(validJson), '先调研 X 然后写报告');
  assert(plan !== null, '合法 JSON → 解析成功');
  assert(plan!.steps.length === 2, '解析出 2 个 step');
  assert(plan!.steps[0].id === 's1' && plan!.steps[1].depends_on?.[0] === 's1', 'step 依赖关系正确');

  // 被 markdown 包裹的 JSON
  const wrappedJson = '```json\n' + validJson + '\n```';
  const plan2 = await planTask(new StubLLM(wrappedJson), 'X');
  assert(plan2 !== null && plan2.steps.length === 2, '去掉 markdown 包裹后能解析');

  // 非法 JSON → null
  const plan3 = await planTask(new StubLLM('this is not json'), 'X');
  assert(plan3 === null, '非法 JSON → null');

  // 缺字段 → schema 失败 → null
  const badSchema = '{"steps": [{"id": "s1"}]}';   // 缺 description
  const plan4 = await planTask(new StubLLM(badSchema), 'X');
  assert(plan4 === null, '缺 description → schema 校验失败 → null');

  // steps=0 也拒绝
  const emptyPlan = '{"steps": []}';
  const plan5 = await planTask(new StubLLM(emptyPlan), 'X');
  assert(plan5 === null, '空 steps → null');
}

// ───── C. revisePlan ─────
{
  const revisedJson = `{
  "steps": [
    {"id": "s2b", "description": "改用 calculator 直接算", "success_criteria": "拿到数字"}
  ]
}`;
  const plan = await revisePlan(new StubLLM(revisedJson), {
    userMessage: '先算 X 然后写到 data/x.md',
    failedStepId: 's2',
    failureReason: '路径越界',
    completedSteps: [{ id: 's1', description: '算 X', outputDigest: '42' }],
    remainingSteps: [{ id: 's2', description: '写到 ../etc/x' }],
  });
  assert(plan !== null, 'revisePlan 解析成功');
  assert(plan!.steps.length === 1, 'revised plan 含 1 步');
  assert(plan!.steps[0].id === 's2b', 'revised step id = s2b');

  // 失败：JSON 解析挂 → null
  const plan2 = await revisePlan(new StubLLM('not json'), {
    userMessage: 'X', failedStepId: 's1', failureReason: 'err',
    completedSteps: [], remainingSteps: [],
  });
  assert(plan2 === null, 'revisePlan 非法 JSON → null');
}

// ───── D. renderPlanForConductor ─────
{
  const plan: Plan = {
    steps: [
      { id: 's1', description: '调研 X' },
      { id: 's2', description: '写报告', success_criteria: '文件存在', depends_on: ['s1'] },
    ],
  };
  const rendered = renderPlanForConductor(plan);
  assert(/本任务的执行计划/.test(rendered), '渲染含计划标题');
  assert(/s1.*调研 X/.test(rendered), 's1 行渲染正确');
  assert(/s2.*写报告.*依赖 s1.*文件存在/.test(rendered), 's2 行含依赖 + 验收');
}

console.log('\n全部通过 ✅');
