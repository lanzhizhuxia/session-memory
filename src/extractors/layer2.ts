/**
 * Layer 2: Semi-structured extraction — PRD §5.3
 * First user message intent classification + tech keyword extraction.
 * Generates: work-patterns.md, tech-preferences.md
 */

import type { Session, MergedProject } from '../adapters/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { NoiseFilter } from '../utils/noise-filter.js';
import type { MemoryTechPreference } from '../memory/types.js';
import { cleanTitle } from '../canonical/views/view-text.js';

const EXAMPLE_NOISE_PATTERNS = [
  /\[(?:INFO|DEBUG|WARN(?:ING)?|ERROR|TRACE)\]/i,
  /<\/?local-command-caveat>/i,
  /computer_use_demo/i,
  /\.tools\.logger/i,
  /^\s*\[(?:TEAM_STATUS|Pasted)\b/i,
  /^\s*(?:hello|hi|test|测试|pong)\s*$/i,
];

function isHighQualityExample(input: string | null | undefined): boolean {
  const value = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (value.length < 10) return false;
  return !EXAMPLE_NOISE_PATTERNS.some((pattern) => pattern.test(value));
}

// ============================================================
// Task type classification — PRD §5.3.1
// ============================================================

const TASK_TYPE_PATTERNS: Array<{ category: string; patterns: RegExp[] }> = [
  {
    category: 'Bug 修复',
    patterns: [/\bfix\b/i, /\bbug\b/i, /\berror\b/i, /\bbroken\b/i, /\b修复\b/, /\b报错\b/, /\b出错\b/, /\b问题\b/],
  },
  {
    category: '新功能开发',
    patterns: [/\badd\b/i, /\bcreate\b/i, /\bimplement\b/i, /\bnew\b/i, /\b新增\b/, /\b添加\b/, /\b实现\b/, /\b开发\b/],
  },
  {
    category: '重构',
    patterns: [/\brefactor\b/i, /\brewrite\b/i, /\bredesign\b/i, /\b重构\b/, /\b重写\b/, /\b改造\b/],
  },
  {
    category: 'PRD/文档',
    patterns: [/\bprd\b/i, /\bdoc\b/i, /\breadme\b/i, /\bwrite.*doc/i, /\b文档\b/, /\b需求\b/, /\bPRD\b/],
  },
  {
    category: '配置/部署',
    patterns: [/\bdeploy\b/i, /\bci\b/i, /\bcd\b/i, /\bconfig\b/i, /\bsetup\b/i, /\b部署\b/, /\b配置\b/, /\b安装\b/],
  },
  {
    category: '调研/探索',
    patterns: [/\bresearch\b/i, /\bexplore\b/i, /\bevaluate\b/i, /\bcompare\b/i, /\b调研\b/, /\b探索\b/, /\b对比\b/, /\b评估\b/],
  },
  {
    category: '迁移/升级',
    patterns: [/\bmigrat/i, /\bupgrad/i, /\bupdate\b/i, /\b迁移\b/, /\b升级\b/, /\b更新\b/],
  },
  {
    category: '测试',
    patterns: [/\btest\b/i, /\bspec\b/i, /\b测试\b/, /\b验证\b/],
  },
];

// ============================================================
// First message pattern classification — PRD §4.6
// ============================================================

const FIRST_MSG_PATTERNS: Array<{ pattern: string; test: (msg: string) => boolean }> = [
  {
    pattern: '指令式（直接下达任务）',
    test: (msg) => /^(fix|add|create|implement|update|remove|delete|change|make|write|build|setup|configure|deploy|refactor|rewrite|migrate|把|帮|改|加|删|写|实现|修|重构|部署|配置)/i.test(msg.trim()),
  },
  {
    pattern: 'PRD 先行（贴需求文档）',
    test: (msg) => msg.length > 500 || /^#\s/.test(msg) || /\bprd\b/i.test(msg.slice(0, 100)),
  },
  {
    pattern: '讨论式（提问/探讨）',
    test: (msg) => /^(how|what|why|should|can|is|do|which|这个|怎么|为什么|要不要|有没有|你觉得|如何|该|能不能)/i.test(msg.trim()) || /\?$/.test(msg.trim()),
  },
  {
    pattern: '链接/截图（贴 URL 或图）',
    test: (msg) => /https?:\/\//.test(msg.slice(0, 200)) || /\.(png|jpg|jpeg|gif|svg|webp)\b/i.test(msg.slice(0, 200)),
  },
];

// ============================================================
// Tech keyword extraction — PRD §5.3.2
// ============================================================

interface TechKeyword {
  category: string;
  name: string;
  patterns: RegExp[];
}

const CATEGORY_ORDER = ['前端', '后端', 'AI', '工具', '部署'];

const TECH_KEYWORDS: TechKeyword[] = [
  // 框架
  { category: '前端', name: 'Next.js', patterns: [/\bnext\.?js\b/i, /\bnextjs\b/i, /\bapp\s*router\b/i] },
  { category: '前端', name: 'React', patterns: [/\breact\b/i] },
  { category: '前端', name: 'Vue', patterns: [/\bvue\b/i, /\bnuxt\b/i] },
  { category: '前端', name: 'Tailwind CSS', patterns: [/\btailwind\b/i] },
  { category: '前端', name: 'shadcn/ui', patterns: [/\bshadcn\b/i] },
  { category: '前端', name: 'Vite', patterns: [/\bvite\b/i, /\bvitepress\b/i] },
  // 后端
  { category: '后端', name: 'Drizzle ORM', patterns: [/\bdrizzle\b/i] },
  { category: '后端', name: 'Prisma', patterns: [/\bprisma\b/i] },
  { category: '后端', name: 'SQLite', patterns: [/\bsqlite\b/i] },
  { category: '后端', name: 'PostgreSQL', patterns: [/\bpostgres\b/i, /\bpostgresql\b/i] },
  { category: '后端', name: 'Express', patterns: [/\bexpress\b/i] },
  { category: '后端', name: 'Hono', patterns: [/\bhono\b/i] },
  { category: '后端', name: 'Node.js', patterns: [/\bnode\.?js\b/i, /\bnodejs\b/i] },
  { category: '后端', name: 'Docker', patterns: [/\bdocker\b/i, /\bdockerfile\b/i] },
  { category: '后端', name: 'node-cron', patterns: [/\bnode-cron\b/i, /\bcron\b/i] },
  // AI
  { category: 'AI', name: 'Claude', patterns: [/\bclaude\b/i, /\banthropic\b/i] },
  { category: 'AI', name: 'Gemini', patterns: [/\bgemini\b/i] },
  { category: 'AI', name: 'OpenAI', patterns: [/\bopenai\b/i, /\bgpt\b/i, /\bchatgpt\b/i] },
  { category: 'AI', name: 'LiteLLM', patterns: [/\blitellm\b/i] },
  { category: 'AI', name: 'Vercel AI SDK', patterns: [/\bvercel\s*ai\b/i, /\bai\s*sdk\b/i] },
  { category: 'AI', name: 'LangChain', patterns: [/\blangchain\b/i] },
  // 工具
  { category: '工具', name: 'Playwright', patterns: [/\bplaywright\b/i] },
  { category: '工具', name: 'MCP', patterns: [/\bmcp\b/i] },
  { category: '工具', name: 'GitHub Actions', patterns: [/\bgithub\s*actions?\b/i, /\bci\/cd\b/i] },
  { category: '工具', name: 'TypeScript', patterns: [/\btypescript\b/i, /\b\.ts\b/] },
  { category: '工具', name: 'ESLint', patterns: [/\beslint\b/i] },
  { category: '工具', name: 'Vitest', patterns: [/\bvitest\b/i] },
  // 部署
  { category: '部署', name: 'Vercel', patterns: [/\bvercel\b/i] },
  { category: '部署', name: 'GitHub Pages', patterns: [/\bgithub\s*pages\b/i] },
  { category: '部署', name: 'NAS', patterns: [/\bnas\b/i, /\bsynology\b/i] },
];

// ============================================================
// Layer 2 data structures
// ============================================================

export interface TaskTypeStats {
  category: string;
  count: number;
  percent: number;
  exampleSession?: { title: string; sourceLabel: string };
}

export interface HourStats {
  hour: number;
  count: number;
}

export interface FirstMsgPatternStats {
  pattern: string;
  count: number;
  example?: string;
}

export interface TechMention {
  category: string;
  name: string;
  sessionCount: number;
  projects: Set<string>;
}

export interface Layer2Result {
  taskTypes: TaskTypeStats[];
  hourDistribution: HourStats[];
  firstMsgPatterns: FirstMsgPatternStats[];
  techMentions: TechMention[];
  workPatternsContent: string;
  techPreferencesContent: string;
}

// ============================================================
// Layer 2 runner
// ============================================================

export async function runLayer2(
  registry: AdapterRegistry,
  noiseFilter: NoiseFilter,
  mergedProjects: MergedProject[],
  sourceSummary: string,
  existingWorkPatterns?: string,
  existingTechPrefs?: string,
  memoryTechPreferences?: MemoryTechPreference[],
): Promise<Layer2Result> {
  // Collect all non-noise sessions
  const allSessions: Array<{ session: Session; projectName: string }> = [];
  for (const mp of mergedProjects) {
    if (noiseFilter.isNoise(mp)) continue;
    const sessions = await registry.getSessions(mp);
    for (const s of sessions) {
      allSessions.push({ session: s, projectName: mp.name });
    }
  }

  // Accumulators
  const taskTypeCounts = new Map<string, { count: number; example?: { title: string; sourceLabel: string } }>();
  const hourCounts = new Array(24).fill(0) as number[];
  const firstMsgCounts = new Map<string, { count: number; example?: string }>();
  const techCounts = new Map<string, TechMention>();
  let otherCount = 0;

  // Process each session — get first user message
  for (const { session, projectName } of allSessions) {
    const sourceLabel = registry.getSourceLabel(session.source);

    // Hour distribution
    const hour = new Date(session.timeCreated).getHours();
    hourCounts[hour]++;

    // Classify task type from session title
    const titleText = session.title ?? '';
    let classified = false;
    for (const tt of TASK_TYPE_PATTERNS) {
      if (tt.patterns.some(p => p.test(titleText))) {
        const entry = taskTypeCounts.get(tt.category) ?? { count: 0 };
        entry.count++;
        if (!entry.example && titleText && isHighQualityExample(titleText)) {
          entry.example = { title: titleText, sourceLabel };
        }
        taskTypeCounts.set(tt.category, entry);
        classified = true;
        break;
      }
    }
    if (!classified) otherCount++;

    // Get first user message for pattern + tech analysis
    const messages = await registry.getMessages(session);
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg) continue;
    const msgContent = firstUserMsg.content;

    // First message pattern
    let patternMatched = false;
    for (const fmp of FIRST_MSG_PATTERNS) {
      if (fmp.test(msgContent)) {
        const entry = firstMsgCounts.get(fmp.pattern) ?? { count: 0 };
        entry.count++;
        const example = msgContent.slice(0, 80).replace(/\n/g, ' ');
        if (!entry.example && isHighQualityExample(example)) {
          entry.example = example;
        }
        firstMsgCounts.set(fmp.pattern, entry);
        patternMatched = true;
        break;
      }
    }
    if (!patternMatched) {
      const entry = firstMsgCounts.get('其他') ?? { count: 0 };
      entry.count++;
      firstMsgCounts.set('其他', entry);
    }

    // Tech keyword matching on first message + title
    const searchText = `${titleText} ${msgContent}`;
    for (const tk of TECH_KEYWORDS) {
      if (tk.patterns.some(p => p.test(searchText))) {
        const key = `${tk.category}:${tk.name}`;
        if (!techCounts.has(key)) {
          techCounts.set(key, {
            category: tk.category,
            name: tk.name,
            sessionCount: 0,
            projects: new Set(),
          });
        }
        const tm = techCounts.get(key)!;
        tm.sessionCount++;
        tm.projects.add(projectName);
      }
    }
  }

  // Build results
  const totalSessions = allSessions.length;

  // Task types
  if (otherCount > 0) {
    taskTypeCounts.set('其他', { count: otherCount });
  }
  const taskTypes: TaskTypeStats[] = Array.from(taskTypeCounts.entries())
    .map(([category, data]) => ({
      category,
      count: data.count,
      percent: totalSessions > 0 ? Math.round((data.count / totalSessions) * 100) : 0,
      exampleSession: data.example,
    }))
    .sort((a, b) => b.count - a.count);

  // Hour distribution
  const hourDistribution: HourStats[] = hourCounts.map((count, hour) => ({ hour, count }));

  // First message patterns
  const firstMsgPatterns: FirstMsgPatternStats[] = Array.from(firstMsgCounts.entries())
    .map(([pattern, data]) => ({
      pattern,
      count: data.count,
      example: data.example,
    }))
    .sort((a, b) => b.count - a.count);

  // Tech mentions
  const techMentions: TechMention[] = Array.from(techCounts.values())
    .sort((a, b) => b.sessionCount - a.sessionCount);

  // Render
  const workPatternsContent = renderWorkPatterns(taskTypes, hourDistribution, firstMsgPatterns, sourceSummary, existingWorkPatterns);
  const techPreferencesContent = renderTechPreferences(techMentions, sourceSummary, existingTechPrefs, memoryTechPreferences);

  return {
    taskTypes,
    hourDistribution,
    firstMsgPatterns,
    techMentions,
    workPatternsContent,
    techPreferencesContent,
  };
}

// ============================================================
// Rendering — PRD §6.1.2
// ============================================================

function makeBar(count: number, maxCount: number): string {
  const maxBars = 10;
  const filled = maxCount > 0 ? Math.round((count / maxCount) * maxBars) : 0;
  return '█'.repeat(filled) + '░'.repeat(maxBars - filled);
}

function renderWorkPatterns(
  taskTypes: TaskTypeStats[],
  hourDistribution: HourStats[],
  firstMsgPatterns: FirstMsgPatternStats[],
  sourceSummary: string,
  existingContent?: string,
): string {
  const { fileHeader, extractUserNotes } = rendererHelpers();
  const userNotes = extractUserNotes(existingContent);

  const lines: string[] = [];
  lines.push(fileHeader('工作模式', sourceSummary));
  lines.push('');

  // Task types table
  lines.push('## 高频任务类型');
  lines.push('');
  lines.push('| 类型 | 频次 | 占比 | 典型 session |');
  lines.push('|---|---|---|---|');
  for (const tt of taskTypes) {
    const example = tt.exampleSession
      ? `"${escapeTableCell(cleanTitle(tt.exampleSession.title).slice(0, 40))}"`
      : '—';
    lines.push(`| ${escapeTableCell(tt.category)} | ${tt.count} | ${tt.percent}% | ${example} |`);
  }
  lines.push('');

  // Hour distribution
  lines.push('## 时段分布');
  lines.push('');
  lines.push('| 时段 | 活跃度 |');
  lines.push('|---|---|');
  const maxHourCount = Math.max(...hourDistribution.map(h => h.count));
  for (const h of hourDistribution) {
    if (h.count > 0) {
      const hourStr = String(h.hour).padStart(2, '0');
      lines.push(`| ${hourStr}:00-${hourStr}:59 | ${makeBar(h.count, maxHourCount)} ${h.count} sessions |`);
    }
  }
  lines.push('');

  // First message patterns
  lines.push('## 首条消息模式');
  lines.push('');
  lines.push('| 模式 | 频次 | 示例 |');
  lines.push('|---|---|---|');
  for (const fmp of firstMsgPatterns) {
    const example = fmp.example ? `"${escapeTableCell(fmp.example)}"` : '—';
    lines.push(`| ${escapeTableCell(fmp.pattern)} | ${fmp.count} | ${example} |`);
  }
  lines.push('');

  // User notes
  if (userNotes) {
    lines.push(userNotes);
  } else {
    lines.push('<!-- user notes -->');
    lines.push('<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->');
    lines.push('<!-- /user notes -->');
  }
  lines.push('');

  return lines.join('\n');
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderTechPreferences(
  techMentions: TechMention[],
  sourceSummary: string,
  existingContent?: string,
  memoryPrefs?: MemoryTechPreference[],
): string {
  const { fileHeader, extractUserNotes } = rendererHelpers();
  const userNotes = extractUserNotes(existingContent);

  const lines: string[] = [];
  lines.push(fileHeader('技术偏好', sourceSummary));
  lines.push('');

  // Merge memory-derived preferences as a separate section at the top
  if (memoryPrefs && memoryPrefs.length > 0) {
    const memByCategory = new Map<string, MemoryTechPreference[]>();
    for (const mp of memoryPrefs) {
      if (!memByCategory.has(mp.category)) memByCategory.set(mp.category, []);
      memByCategory.get(mp.category)!.push(mp);
    }
    const sortedMemoryCategories = Array.from(memByCategory.keys()).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    for (const category of sortedMemoryCategories) {
      const prefs = memByCategory.get(category)!;
      lines.push(`## ${category}（记忆来源）`);
      for (const p of prefs) {
        lines.push(`- **${p.techName}**: ${p.description} — *[${p.sourceLabel}] ${p.sourcePath}*`);
      }
      lines.push('');
    }
  }

  // Session-derived tech mentions (existing logic)
  const byCategory = new Map<string, TechMention[]>();
  for (const tm of techMentions) {
    if (!byCategory.has(tm.category)) byCategory.set(tm.category, []);
    byCategory.get(tm.category)!.push(tm);
  }

  // Sort categories in a sensible order
  const sortedCategories = Array.from(byCategory.keys()).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (const category of sortedCategories) {
    const mentions = byCategory.get(category)!;
    lines.push(`## ${category}`);
    for (const tm of mentions) {
      const projectList = Array.from(tm.projects).join(', ');
      lines.push(`- **${tm.name}** — *${tm.sessionCount} sessions, ${projectList}*`);
    }
    lines.push('');
  }

  // User notes
  if (userNotes) {
    lines.push(userNotes);
  } else {
    lines.push('<!-- user notes -->');
    lines.push('<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->');
    lines.push('<!-- /user notes -->');
  }
  lines.push('');

  return lines.join('\n');
}

/** Shared renderer helpers to avoid circular dependency with renderer.ts */
function rendererHelpers() {
  function formatISO(date: Date = new Date()): string {
    return date.toISOString().replace('Z', '+00:00');
  }

  function fileHeader(title: string, sourceSummary: string, now: Date = new Date()): string {
    return `<!-- generated: ${formatISO(now)} -->\n<!-- sources: ${sourceSummary} -->\n# ${title}\n`;
  }

  function extractUserNotes(content?: string): string | null {
    if (!content) return null;
    const startTag = '<!-- user notes -->';
    const endTag = '<!-- /user notes -->';
    const startIdx = content.indexOf(startTag);
    const endIdx = content.indexOf(endTag);
    if (startIdx === -1 || endIdx === -1) return null;
    return content.slice(startIdx, endIdx + endTag.length);
  }

  return { formatISO, fileHeader, extractUserNotes };
}
