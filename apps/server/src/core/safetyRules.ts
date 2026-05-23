/**
 * 危险命令 / 模式黑名单 —— 通用 before:tool:call hook。
 *
 * 设计原则：
 *   1. **硬挂掉**：匹配上 → 直接 deny，不弹审批不让 LLM 试。安全网应该是"零容忍"，
 *      可批准的危险操作应该走显式审批 UI（未来叠加），而不是混在这里。
 *   2. **递归扫描**：危险串可能藏在嵌套 JSON 里（比如 `{ args: ['rm', '-rf', '/'] }` 或
 *      `{ command: 'rm -rf /' }`），所以把整个 input JSON.stringify 后再 regex 匹配。
 *   3. **工具无关**：不限定只对 bash / shell tool 生效——MCP 接进来的任意 tool 都过滤。
 *      代价：偶尔会误伤（比如有人确实想搜"rm -rf"这串字面量），但安全优先于便利。
 *   4. **deny 不是 throw**：返回 hook outcome，由 conductor 当成 tool_result 喂给 LLM
 *      ("operation denied: rm -rf pattern matched")，让 LLM 改方案而不是挂 turn。
 */
import type { HookHandler } from './hooks.js';
import { registerHook } from './hooks.js';
import { config } from '../config.js';

export interface DangerRule {
  /** 给日志 + LLM 看的名字 */
  name: string;
  /** 描述给 LLM 看的 deny reason */
  reason: string;
  /** 在 input JSON 文本上跑的正则；命中即 deny */
  pattern: RegExp;
}

/**
 * 内置规则。注意正则要兼顾**变体**：
 *   - rm -rf /         空格分隔
 *   - rm -fr /         flag 顺序变
 *   - rm  -rf /        多空格
 *   - rm -r -f /       拆开两个 flag
 *   - rm --recursive --force /
 * 都得覆盖。但又不能太宽——"rm myfile" 是合法的，不能误伤。
 *
 * 规则只关注**真正不可恢复**的破坏：删整树 / 覆盖磁盘 / fork bomb / DROP DATABASE 等。
 * 单文件删除、git reset、npm install 这些有副作用但可恢复的不进黑名单（让 hook 框架的
 * 后续审批层管）。
 */
export const DEFAULT_DANGER_RULES: DangerRule[] = [
  // ── Unix 删树 ──
  // rm -rf / / rm -fr / / rm -r -f / / rm --recursive --force / 等
  // 目标路径只要是 / ~ * . 这类指向"根 / 家目录 / 任意"的字符就拦
  {
    name: 'rm-rf-root',
    reason: 'rm -rf 删整树是不可恢复的破坏操作。如果只是删特定文件，请用 fs.unlink 类工具按单文件操作。',
    pattern: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\s+(?:[~/.*]|\$HOME|\$\{HOME\})/,
  },
  // rm -rf 路径明确不是 /tmp 之类临时目录时也拦（更宽松一点）：rm -rf 任意路径都看一眼
  {
    name: 'rm-rf-generic',
    reason: 'rm -rf 命令一律不允许。需要清理目录请用 fs 工具按需删除单文件。',
    pattern: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/,
  },
  // ── 磁盘 / 设备覆盖 ──
  {
    name: 'dd-disk-overwrite',
    reason: 'dd if=... of=/dev/... 会覆盖整块磁盘，不可恢复。',
    pattern: /\bdd\s+.*\bof=\/dev\/(?:sd[a-z]|nvme|disk|hd[a-z])/,
  },
  {
    name: 'mkfs-format',
    reason: 'mkfs 会格式化分区，不可恢复。',
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//,
  },
  {
    name: 'redirect-to-device',
    reason: '把内容重定向到 /dev/sda 等设备会破坏磁盘。',
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme|disk|hd[a-z])/,
  },
  // ── fork bomb ──
  {
    name: 'fork-bomb',
    reason: 'fork bomb 会瞬间耗尽系统进程，让机器宕机。',
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  // ── 危险下载 + 执行 ──
  // curl ... | sh / wget ... | bash 类 pipe-to-shell
  {
    name: 'curl-pipe-shell',
    reason: '不要把网络下载内容直接 pipe 到 shell（任意代码执行风险）。',
    pattern: /\b(?:curl|wget)\s+[^|&;\n]+\|\s*(?:sh|bash|zsh|fish)\b/,
  },
  // ── Windows ──
  {
    name: 'windows-format',
    reason: 'format c: / format d: 等命令会格式化分区。',
    // 不用 $ 锚行尾（被 JSON 化后失效）；放宽到看见 format <letter>: 就拦
    pattern: /\bformat\s+[a-zA-Z]:(?:\s|\\|"|$)/i,
  },
  {
    name: 'windows-del-system',
    reason: 'del /s /q c:\\ 会递归删除系统盘内容。',
    pattern: /\bdel\s+(?:\/[a-zA-Z]\s+)*(?:[a-zA-Z]:\\(?:windows|system32)?|c:\\)/i,
  },
  {
    name: 'powershell-recursive-remove-root',
    reason: 'Remove-Item -Recurse -Force 目标是根 / 家目录是危险操作。',
    pattern: /\bRemove-Item\s+(?:.*?-Recurse|.*?-r)\b.*?(?:-Force|-f).*?(?:[~/]|\$HOME|c:\\)/i,
  },
  // ── 数据库破坏 ──
  {
    name: 'sql-drop-database',
    reason: 'DROP DATABASE 会删除整个库。',
    pattern: /\bdrop\s+database\b/i,
  },
  {
    name: 'sql-drop-table-no-where',
    reason: 'DROP TABLE 不可恢复（如果确认要删表，请走 migration / 显式审批）。',
    pattern: /\bdrop\s+table\b/i,
  },
  {
    name: 'sql-delete-without-where',
    reason: 'DELETE 缺少 WHERE 条件会清空整个表。',
    // 用 negative lookahead：DELETE FROM <table> 后面不跟 WHERE 才拦
    // 注意：不能用 `$` 锚行尾——input 通常被 JSON.stringify 后再匹配，行尾已经被 `"}` 占了
    pattern: /\bdelete\s+from\s+\w+\b(?!\s+where\b)/i,
  },
  {
    name: 'sql-truncate',
    reason: 'TRUNCATE TABLE 会清空表内容且不走事务日志，不可恢复。',
    pattern: /\btruncate\s+(?:table\s+)?\w+/i,
  },
  // ── git 破坏性操作 ──
  // 注：常规 git reset --hard / git push --force 在工程里偶尔合法，所以不放在内置黑名单里。
  // 真要拦应走显式审批 hook，而不是内置硬拦。

  // ── Python 沙箱越权（code_execute tool） ──
  // Pyodide 默认无 os / subprocess，但 LLM 真写出来浪费 token，先 deny + 给清晰 reason
  {
    name: 'python-os-system',
    reason: 'Python 代码不允许调 os.system / subprocess —— Pyodide-in-Node 实际能透传到宿主文件系统，os.system 等价于真 shell。如要跑 shell 改用 fileSystem 工具。',
    // 注意：不用 \b / 不用前缀检查。原因：input 通常被 JSON.stringify 后才匹配，
    // \n 变成字面 `\n`（反斜杠 + n），n 是 word char 让 \b 和 [^a-zA-Z0-9_] 前缀检查全部失效。
    // 直接匹配整个字符串里的 `os.system(`，接受 `foo.os.system(` 这种罕见的误命中。
    pattern: /os\.system\s*\(|subprocess\.(?:run|call|Popen|check_(?:call|output))\s*\(|os\.popen\s*\(/,
  },
  {
    name: 'python-eval-exec',
    reason: 'Python eval() / exec() / compile() 在沙箱里仍能拼出恶意调用；请直接写代码而不是动态拼字符串。',
    // 同上，简化前缀检查。注意 `\beval` / `\bexec` 仍能命中 `myexec(`，故要求紧跟 `(` 而不是 word char
    pattern: /(?:^|[^a-zA-Z0-9_.])(?:eval|exec|compile)\s*\(/m,
  },
  {
    name: 'python-import-dangerous',
    reason: 'Python __import__("os") / __import__("subprocess") 是动态导入危险模块的常见绕过手法。',
    // 注意：JSON.stringify input 后 `"` 变 `\"`；要兼容字面引号 + 转义引号，前后允许 \\?["']
    pattern: /__import__\s*\(\s*\\?["'](?:os|subprocess|ctypes|sys)\\?["']/,
  },
];

/**
 * 把 unknown input 序列化成可 regex 匹配的文本。
 * 注意：JSON.stringify 会把字符串里的 `"` 转义为 `\"`，正则匹配时不受影响。
 */
function stringifyForMatch(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input == null) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export function checkDangerous(
  input: unknown,
  rules: DangerRule[] = DEFAULT_DANGER_RULES,
): DangerRule | null {
  const text = stringifyForMatch(input);
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}

/**
 * 注册到 before:tool:call 的内置安全 hook。
 * 在 server bootstrap 时调一次就够了；幂等（多次调用会注册多个但行为一致）。
 *
 * 用户自定义额外规则：
 *   - 编程式：installDefaultSafetyHooks([...DEFAULT_DANGER_RULES, myCustomRule])
 *   - 通过环境变量：设置 SAFETY_EXTRA_RULES=JSON（见 loadExtraRulesFromEnv）
 */
export function installDefaultSafetyHooks(
  rules: DangerRule[] = [...DEFAULT_DANGER_RULES, ...loadExtraRulesFromEnv()],
): () => void {
  const handler: HookHandler<'before:tool:call'> = (ctx) => {
    const hit = checkDangerous(ctx.input, rules);
    if (hit) {
      return { allow: false, reason: hit.reason, ruleName: hit.name };
    }
    return { allow: true };
  };
  return registerHook('before:tool:call', handler);
}

/**
 * 从环境变量 SAFETY_EXTRA_RULES 加载用户自定义规则。
 *
 * 格式：JSON array，每条 `{ name, reason, pattern, flags? }`：
 *   SAFETY_EXTRA_RULES='[{"name":"no-prod-deploy","reason":"禁止从 LLM 调 prod 部署","pattern":"kubectl\\\\s+apply.*prod","flags":"i"}]'
 *
 * 注意 JSON 里的 `\` 需要转义两次（一次给 JSON、一次给 regex），所以 `\s` 在 env 里写成 `\\\\s`。
 *
 * 解析失败的项跳过 + 日志 warn，不让单条坏规则把整个 server 挂掉。
 */
export function loadExtraRulesFromEnv(): DangerRule[] {
  // 优先从 process.env 读（让测试 / 运行时切换生效）；空 → 用 boot 时锁定的 config 值
  const raw = process.env.SAFETY_EXTRA_RULES || config.safety.extraRulesRaw;
  if (!raw || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 不导入 logger 避免循环依赖，用 console
    console.warn('[safety] SAFETY_EXTRA_RULES JSON 解析失败：', (err as Error).message);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[safety] SAFETY_EXTRA_RULES 必须是 JSON array');
    return [];
  }
  const out: DangerRule[] = [];
  for (const item of parsed) {
    const r = item as { name?: string; reason?: string; pattern?: string; flags?: string };
    if (!r?.name || !r?.reason || !r?.pattern) {
      console.warn('[safety] 跳过缺字段的规则：', item);
      continue;
    }
    try {
      out.push({ name: r.name, reason: r.reason, pattern: new RegExp(r.pattern, r.flags ?? 'i') });
    } catch (err) {
      console.warn(`[safety] 规则 ${r.name} 正则无效：`, (err as Error).message);
    }
  }
  if (out.length > 0) {
    console.log(`[safety] 从 SAFETY_EXTRA_RULES 加载了 ${out.length} 条自定义规则`);
  }
  return out;
}
