/** SKILL.md 解析后的 metadata（不含正文，listing 时用） */
export interface SkillMeta {
  name: string;
  description: string;
  source: string;       // 绝对路径，调试用
  scope: 'project' | 'user' | 'plugin';
}

/** 含正文的完整 skill（invoke_skill 时返回） */
export interface Skill extends SkillMeta {
  body: string;
}
