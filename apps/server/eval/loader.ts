import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { EvalTaskSchema, type EvalTask } from './types.js';

const TASKS_ROOT = path.resolve(import.meta.dirname, 'tasks');

/**
 * 递归扫 tasks/**\/*.yaml，逐个 zod 校验。
 * filter: 类似 "math/*" / "math-001"，glob 半套（只支持 dir/* 和精确 id）
 */
export async function loadTasks(filter?: string): Promise<EvalTask[]> {
  const files = await walkYaml(TASKS_ROOT);
  const out: EvalTask[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf-8');
    let parsed: unknown;
    try { parsed = yaml.load(raw); } catch (err) {
      throw new Error(`[eval] yaml 解析失败 ${file}: ${(err as Error).message}`);
    }
    const result = EvalTaskSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`[eval] schema 校验失败 ${file}: ${result.error.message}`);
    }
    out.push(result.data);
  }
  // 去重 id
  const seen = new Set<string>();
  for (const t of out) {
    if (seen.has(t.id)) throw new Error(`[eval] 任务 id 重复: ${t.id}`);
    seen.add(t.id);
  }
  if (filter) {
    return out.filter((t) => matchesFilter(t, filter));
  }
  return out;
}

async function walkYaml(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walkYaml(full)));
    } else if (e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml'))) {
      files.push(full);
    }
  }
  return files.sort();
}

function matchesFilter(task: EvalTask, filter: string): boolean {
  // 精确 id 匹配
  if (task.id === filter) return true;
  // 分类匹配："math/*" 或 "math"
  const f = filter.replace(/\/\*$/, '');
  if (task.category === f) return true;
  // tag 匹配 "tag:xxx"
  if (filter.startsWith('tag:')) {
    return task.tags.includes(filter.slice(4));
  }
  return false;
}
