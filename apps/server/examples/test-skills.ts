/**
 * Skills loader 单测：
 *   - 合法 SKILL.md（有 frontmatter）→ 能 list / get / search
 *   - 缺 name/description → 跳过，不抛
 *   - 不存在的目录 → 静默忽略
 *   - 同名 skill：project 覆盖 user（用临时目录模拟）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillsLoader } from '../src/skills/loader.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-skills-test-'));
const projectDir = path.join(tmpRoot, 'project');
const userDir = path.join(tmpRoot, 'home');
fs.mkdirSync(path.join(projectDir, '.claude/skills'), { recursive: true });
fs.mkdirSync(path.join(userDir, '.claude/skills'), { recursive: true });

function writeSkill(base: string, name: string, body: string): void {
  const dir = path.join(base, '.claude/skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

// 1) 合法
writeSkill(projectDir, 'alpha', `---
name: alpha
description: 第一个测试 skill
---
正文 A
`);

// 2) 缺 description → 应跳过
writeSkill(projectDir, 'broken', `---
name: broken
---
没有 description
`);

// 3) 用户级有 alpha；项目级也有 alpha → 项目盖用户（验证后面）
writeSkill(userDir, 'alpha', `---
name: alpha
description: 用户级旧版本
---
旧正文
`);

// 4) 用户级独有 beta
writeSkill(userDir, 'beta', `---
name: beta
description: 调研类工作流
---
beta 正文
`);

// 切到项目目录运行 loader（loader 用 process.cwd() 找 .claude/skills）
const origCwd = process.cwd();
const origHome = process.env.HOME;
process.chdir(projectDir);
// 让 os.homedir() 返回我们的临时目录（os.homedir 在 macOS/Linux 上读 $HOME）
process.env.HOME = userDir;

const loader = new SkillsLoader();
loader.init();

let pass = 0, fail = 0;
function expect(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name}${detail ? ` —— ${detail}` : ''}`); fail++; }
}

const list = loader.list();
expect('list 返回 2 条（broken 被跳过）', list.length === 2, `actual ${list.length}: ${list.map(s => s.name).join(',')}`);
expect('alpha 存在', list.some(s => s.name === 'alpha'));
expect('beta 存在', list.some(s => s.name === 'beta'));
expect('broken 不存在（缺 description 被跳过）', !list.some(s => s.name === 'broken'));

const alpha = loader.get('alpha');
expect('alpha 正文是项目版（不是用户版）', alpha?.body.includes('正文 A') === true,
  `body: ${alpha?.body.slice(0, 50)}`);
expect('alpha scope 是 project', alpha?.scope === 'project');

const betaResult = loader.get('beta');
expect('beta 可拿到', betaResult !== null);
expect('beta scope 是 user', betaResult?.scope === 'user');

const searched = loader.search('调研');
expect('search "调研" 命中 beta', searched.some(s => s.name === 'beta'));

// 恢复
process.chdir(origCwd);
if (origHome !== undefined) process.env.HOME = origHome;
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '全部通过 ✅' : `失败 ${fail} 条 ❌`}`);
if (fail > 0) process.exit(1);
