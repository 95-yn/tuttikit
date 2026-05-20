/**
 * 集成测试：验证 AISDKProvider 与 Vercel AI SDK 之间的消息/工具/响应映射全部正确。
 * 不需要任何真实 API Key —— 用 AI SDK 自带的 MockLanguageModelV3 喂回预设响应。
 *
 *   测试 1：一次 chat()，模型不调用工具 → 验证 content + usage 正确解析
 *   测试 2：一次 chat()，模型返回 tool-call → 验证 toolCalls 数组结构对齐
 *   测试 3：把 tool result 喂回去后再 chat() → 验证 _toModelMessages 能产出合法的 v6 消息
 *   测试 4：stream() 的 textStream 能逐字回调
 */
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
  convertArrayToAsyncIterable,
} from 'ai/test';
import { AISDKProvider } from '../src/llm/aisdk.js';

const TOOL_SPEC = {
  name: 'calculator',
  description: 'evaluate a math expression',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
  },
};

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

// ───── 测试 1：纯文本响应 ─────
{
  const mock = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'hello world' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 11 }, outputTokens: { total: 22 }, totalTokens: 33 },
      warnings: [],
    }),
  });
  const provider = new AISDKProvider({ model: mock, name: 'mocked' });
  const res = await provider.chat({
    system: 'you are a test',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  });
  assert(res.content === 'hello world', '纯文本：content 正确');
  assert(res.toolCalls.length === 0, '纯文本：toolCalls 为空');
  assert(res.usage.inputTokens === 11 && res.usage.outputTokens === 22, '纯文本：usage 解析正确');

  const sent = mock.doGenerateCalls[0];
  assert(sent.tools === undefined, '空 tools 不传给 SDK');
}

// ───── 测试 2：模型请求工具调用 ─────
{
  const mock = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tc_1',
          toolName: 'calculator',
          input: JSON.stringify({ expression: '1+2' }),
        },
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: { total: 30 }, outputTokens: { total: 5 }, totalTokens: 35 },
      warnings: [],
    }),
  });
  const provider = new AISDKProvider({ model: mock, name: 'mocked' });
  const res = await provider.chat({
    system: 'you can use tools',
    messages: [{ role: 'user', content: 'compute 1+2' }],
    tools: [TOOL_SPEC],
  });
  assert(res.toolCalls.length === 1, 'tool-call：toolCalls 有一条');
  assert(res.toolCalls[0].name === 'calculator', 'tool-call：name 映射 (toolName→name)');
  assert(res.toolCalls[0].id === 'tc_1', 'tool-call：id 映射 (toolCallId→id)');
  assert(res.toolCalls[0].input.expression === '1+2', 'tool-call：input 解析');

  const sent = mock.doGenerateCalls[0];
  assert(
    sent.tools && sent.tools.length === 1 && sent.tools[0].name === 'calculator',
    'tools 被翻译并下发到 SDK',
  );
  assert(sent.tools[0].inputSchema?.type === 'object', 'tool inputSchema 是 JSON Schema');
}

// ───── 测试 3：tool-result 回填后再调一次 ─────
{
  const mock = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '结果是 3' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 50 }, outputTokens: { total: 8 }, totalTokens: 58 },
      warnings: [],
    }),
  });
  const provider = new AISDKProvider({ model: mock, name: 'mocked' });
  const res = await provider.chat({
    system: 's',
    messages: [
      { role: 'user', content: 'compute 1+2' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'calculator', input: { expression: '1+2' } }],
      },
      {
        role: 'tool',
        toolCallId: 'tc_1',
        toolName: 'calculator',
        content: JSON.stringify({ value: 3 }),
      },
    ],
    tools: [TOOL_SPEC],
  });
  assert(res.content === '结果是 3', 'tool-result：模型基于工具结果继续回答');

  const sent = mock.doGenerateCalls[0];
  const promptMsgs = sent.prompt;
  const toolMsg = promptMsgs.find((m) => m.role === 'tool');
  assert(toolMsg, '消息映射：包含 tool 消息');
  assert(toolMsg.content[0].type === 'tool-result', 'tool 消息是 tool-result part');
  assert(toolMsg.content[0].toolCallId === 'tc_1', 'tool-result：toolCallId 对齐');
  assert(toolMsg.content[0].toolName === 'calculator', 'tool-result：toolName 对齐');
  assert(toolMsg.content[0].output.type === 'json', 'tool-result：output 是 json 包装');
  assert(toolMsg.content[0].output.value.value === 3, 'tool-result：output.value 字段正确');

  const asstMsg = promptMsgs.find((m) => m.role === 'assistant');
  const tcPart = asstMsg.content.find((p) => p.type === 'tool-call');
  assert(tcPart && tcPart.toolCallId === 'tc_1', 'assistant 消息：tool-call part 携带 id');
}

// ───── 测试 4：stream() 逐字回调 ─────
{
  const chunks = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Hel' },
    { type: 'text-delta', id: 't1', delta: 'lo' },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 }, totalTokens: 7 },
    },
  ];
  const mock = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream(chunks),
    }),
  });
  const provider = new AISDKProvider({ model: mock, name: 'mocked' });
  const collected = [];
  const res = await provider.stream(
    { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    (d) => collected.push(d),
  );
  assert(collected.join('') === 'Hello', 'stream：增量回调拼接出完整文本');
  assert(res.content === 'Hello', 'stream：最终 content 与拼接一致');
  assert(res.usage.inputTokens === 5 && res.usage.outputTokens === 2, 'stream：usage 解析正确');
}

console.log('\n全部通过 ✅');
