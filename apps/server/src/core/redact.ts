/**
 * 把 secret 模式从 tool input 里 mask 掉再透传给前端。
 * 用在 safety:denied / permission:requested 这类把 input 全字段发到 UI 的事件上，
 * 避免 LLM 误把 token / API key 放在命令里时一路漏到浏览器 DOM。
 *
 * 不全：但能盖住常见的几大类。Bearer / sk-* / Authorization / 双引号包的 sk-* 等。
 */

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replace: string }> = [
  // Anthropic / OpenAI API key
  { name: 'sk-key',        pattern: /\bsk-[a-zA-Z0-9_-]{16,}\b/g,                replace: 'sk-***REDACTED***' },
  // GitHub PAT
  { name: 'github-pat',    pattern: /\bgh[ps]_[a-zA-Z0-9]{30,}\b/g,             replace: 'gh*_***REDACTED***' },
  // AWS keys
  { name: 'aws-key',       pattern: /\bAKIA[0-9A-Z]{16}\b/g,                     replace: 'AKIA***REDACTED***' },
  // Bearer / Authorization header
  { name: 'bearer',        pattern: /\b(?:[Bb]earer\s+)([a-zA-Z0-9._-]{16,})\b/g, replace: 'Bearer ***REDACTED***' },
  // password=xxx / api_key=xxx / token=xxx
  { name: 'kv-secret',     pattern: /\b(password|passwd|api[_-]?key|secret|token|auth)\s*[=:]\s*['"]?([^\s'"&,;]{8,})['"]?/gi, replace: '$1=***REDACTED***' },
  // JWT (粗略)：xxxxx.yyyyy.zzzzz 三段 base64
  { name: 'jwt',           pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, replace: 'eyJ***REDACTED***' },
  // 私钥头
  { name: 'private-key',   pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, replace: '-----BEGIN PRIVATE KEY-----***REDACTED***-----END PRIVATE KEY-----' },
];

/** 递归 redact：字符串走正则；对象 / 数组深度遍历；原始类型原样返回 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

function redactString(s: string): string {
  let out = s;
  for (const { pattern, replace } of SECRET_PATTERNS) {
    out = out.replace(pattern, replace);
  }
  return out;
}

/** 给单测用：暴露规则数让人 review */
export const REDACT_PATTERN_COUNT = SECRET_PATTERNS.length;
