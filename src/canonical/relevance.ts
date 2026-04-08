export type RelevanceClass =
  | 'noise'
  | 'generic_execution'
  | 'decision_rich'
  | 'preference_rich'
  | 'pain_rich'
  | 'timeline_fact'
  | 'todo_fact';

const NOISE_PATTERNS = [
  /^background:/i,
  /^look_at:/i,
  /^hello$/i,
  /^echo\b/i,
  /^test\b/i,
  /<local-command-caveat>/i,
  /^#\s*$/,
];

const PREFERENCE_PATTERNS = [
  /\bprefer\b/i,
  /\bavoid\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
  /偏好/,
  /禁止/,
  /总是/,
  /优先/,
  /不要/,
];

const TECH_PATTERNS = [
  /\bnext\.?js\b/i,
  /\breact\b/i,
  /\bvue\b/i,
  /\btailwind\b/i,
  /\bshadcn\b/i,
  /\bdrizzle\b/i,
  /\bprisma\b/i,
  /\bsqlite\b/i,
  /\bpostgres(?:ql)?\b/i,
  /\bexpress\b/i,
  /\bhono\b/i,
  /\bdocker\b/i,
  /\bnode\.?js\b/i,
  /\btypescript\b/i,
  /\bplaywright\b/i,
  /\bopenai\b/i,
  /\bclaude\b/i,
  /\blitellm\b/i,
  /\bvercel\s*ai\b/i,
  /\blangchain\b/i,
  /\bmcp\b/i,
];

const DECISION_PATTERNS = [
  /\bchose\b/i,
  /\bchoose\b/i,
  /\bdecid(?:e|ed|ing)\b/i,
  /\binstead of\b/i,
  /\btrade[- ]?off\b/i,
  /\bover\b/i,
  /选择.*而不是/,
  /改用/,
  /放弃/,
  /选择/,
  /决定/,
  /替代方案/,
];

const PAIN_PATTERNS = [
  /\berror\b/i,
  /\bbug\b/i,
  /\bdebug\b/i,
  /\bfix\b/i,
  /\bworkaround\b/i,
  /\broot cause\b/i,
  /报错/,
  /排查/,
  /修复/,
  /踩坑/,
];

const TIMELINE_PATTERNS = [
  /\bdeploy(?:ed)?\b/i,
  /\brelease(?:d)?\b/i,
  /\bshipped?\b/i,
  /\bcompleted?\b/i,
  /上线/,
  /发布/,
  /完成/,
  /交付/,
];

const TODO_PATTERNS = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bnext step\b/i,
  /\bblocked\b/i,
  /\bin progress\b/i,
  /待办/,
  /未完成/,
  /下一步/,
  /待跟进/,
];

export function classifyRelevance(text: string, title?: string): RelevanceClass {
  const combined = `${title ?? ''} ${text.slice(0, 500)}`;
  const joined = `${title ?? ''}\n${text}`.trim();

  if (NOISE_PATTERNS.some((pattern) => pattern.test(title ?? ''))) {
    return 'noise';
  }

  if (combined.trim().length === 0) {
    return 'noise';
  }

  if (TODO_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'todo_fact';
  }

  if (DECISION_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'decision_rich';
  }

  if (PREFERENCE_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'preference_rich';
  }

  if (PAIN_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'pain_rich';
  }

  if (TIMELINE_PATTERNS.some((pattern) => pattern.test(joined))) {
    return 'timeline_fact';
  }

  if (
    TECH_PATTERNS.some((pattern) => pattern.test(joined))
  ) {
    return 'preference_rich';
  }

  return 'generic_execution';
}
