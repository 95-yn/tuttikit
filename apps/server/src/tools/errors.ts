import type { ZodError } from 'zod';

/**
 * Tool 入参 zod 校验失败。
 * Conductor 主循环会把它转成结构化 tool_result 喂回 LLM 让其自修复，而不是终止本轮。
 */
export class ToolInputError extends Error {
  readonly toolName: string;
  readonly issues: ReturnType<ZodError['format']>;
  readonly receivedInput: unknown;

  constructor(toolName: string, zodError: ZodError, receivedInput: unknown) {
    super(`tool ${toolName} input validation failed`);
    this.name = 'ToolInputError';
    this.toolName = toolName;
    this.issues = zodError.format();
    this.receivedInput = receivedInput;
  }

  /** 给 LLM 看的 JSON 形式 —— 简洁 + 包含 "怎么改" 的 hint */
  toLLMPayload(): {
    error: 'input_validation_failed';
    tool: string;
    issues: unknown;
    receivedInput: unknown;
    hint: string;
  } {
    return {
      error: 'input_validation_failed',
      tool: this.toolName,
      issues: this.issues,
      receivedInput: this.receivedInput,
      hint: '请按 tool 的 parameters schema 重新生成 input，注意字段类型（如 expression 必须是字符串而非数字）。',
    };
  }
}

/**
 * Safety hook deny → 抛这个错。
 * conductor / sub-agent 看到这个类型时知道是"被拦截"而不是"工具内部错"，
 * 给 LLM 的 tool_result 用结构化 payload 而不是 generic message。
 */
export class SafetyDeniedError extends Error {
  constructor(
    public toolName: string,
    public ruleName: string,
    public denyReason: string,
    public input: unknown,
  ) {
    super(`tool ${toolName} 被安全规则 ${ruleName} 拦截：${denyReason}`);
    this.name = 'SafetyDeniedError';
  }
  toLLMPayload(): unknown {
    return {
      error: 'denied_by_safety_rule',
      rule: this.ruleName,
      reason: this.denyReason,
      hint: '该操作被安全规则拦截，请改用更安全的方案或缩小操作范围。',
    };
  }
}

/** Tool handler 运行时抛错的统一包装，方便和 ToolInputError 区分 */
export class ToolHandlerError extends Error {
  readonly toolName: string;
  readonly cause?: unknown;

  constructor(toolName: string, cause: unknown) {
    super(`tool ${toolName} handler failed: ${(cause as Error)?.message ?? cause}`);
    this.name = 'ToolHandlerError';
    this.toolName = toolName;
    this.cause = cause;
  }
}
