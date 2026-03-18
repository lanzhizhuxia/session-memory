/**
 * Layer 3: Deep extraction (AI batch summary) — PRD §5.4
 * High-value session selection → 3 AI prompts per session → aggregate results
 * Generates: decisions.md, pain-points.md, work-profile.md
 */

import type { Session, Message, MergedProject } from '../adapters/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { NoiseFilter } from '../utils/noise-filter.js';

// ============================================================
// Types
// ============================================================

export interface Layer3Config {
  min_score: number;
  max_sessions: number;
  api_key?: string;
  api_base_url?: string;
  model?: string;
}

export interface Decision {
  what: string;
  why: string;
  alternatives: string[];
  trigger: string;
  date: string;
  sessionId: string;
  sessionTitle: string;
  sourceLabel: string;
  projectName: string;
}

export interface PainPoint {
  problem: string;
  diagnosis: string;
  solution: string;
  likely_recurring: boolean;
  sessionId: string;
  sessionTitle: string;
  sourceLabel: string;
  projectName: string;
}

export interface Preference {
  category: string;
  observation: string;
  evidence: string;
}

export interface Layer3Result {
  decisions: Decision[];
  painPoints: PainPoint[];
  preferences: Preference[];
  processedSessionIds: string[];
  failedSessionIds: string[];
  decisionsContent: string;
  painPointsContent: string;
  workProfileContent: string;
}

// ============================================================
// High-value session selection — PRD §5.4.1
// ============================================================

const DECISION_KEYWORDS = /\b(refactor|migrate|design|prd|architecture|choose|vs|选型|迁移|重构|架构|设计|对比|取舍)\b/i;

interface ScoredSession {
  session: Session;
  projectName: string;
  score: number;
}

function scoreSession(
  session: Session,
  allSessions: Session[],
): number {
  let score = 0;

  // Title matches decision keywords: +3
  if (session.title && DECISION_KEYWORDS.test(session.title)) {
    score += 3;
  }

  // codeChurn > 500: +2
  if (session.codeChurn) {
    const totalChurn = session.codeChurn.additions + session.codeChurn.deletions;
    if (totalChurn > 500) score += 2;
  }

  // Same project 24h with 2+ sessions: +2
  const dayMs = 24 * 60 * 60 * 1000;
  const nearbyCount = allSessions.filter(
    s => s.projectId === session.projectId &&
         s.id !== session.id &&
         Math.abs(s.timeCreated - session.timeCreated) < dayMs
  ).length;
  if (nearbyCount >= 1) score += 2; // 2+ sessions means at least 1 other

  // messageCount > 15: +1
  if (session.messageCount > 15) score += 1;

  return score;
}

export async function selectHighValueSessions(
  registry: AdapterRegistry,
  noiseFilter: NoiseFilter,
  mergedProjects: MergedProject[],
  config: Layer3Config,
  alreadyProcessed: Set<string>,
): Promise<ScoredSession[]> {
  const candidates: ScoredSession[] = [];

  for (const mp of mergedProjects) {
    if (noiseFilter.isNoise(mp)) continue;
    const sessions = await registry.getSessions(mp);

    for (const session of sessions) {
      if (alreadyProcessed.has(session.id)) continue;

      // Necessary condition: user messages > 5
      // We check messageCount as a proxy; for accuracy we'd need getMessages
      // but messageCount is available from adapter cache
      if (session.messageCount <= 10) continue; // rough proxy: total msgs > 10 means user msgs likely > 5

      const score = scoreSession(session, sessions);
      if (score >= config.min_score) {
        candidates.push({ session, projectName: mp.name, score });
      }
    }
  }

  // Sort by score descending, cap at max_sessions
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, config.max_sessions);
}

// ============================================================
// AI prompts — PRD §5.4.2
// ============================================================

const DECISION_PROMPT = `你是一个技术决策提取器。只关注决策，忽略其他一切。

分析以下 AI 编码对话，提取所有技术/产品决策：
- 做了什么决定？
- 为什么这么选？
- 考虑过哪些替代方案？为什么否决？
- 什么触发了这个决策？

如果对话中没有明确决策，返回空数组。不要编造。

输出 JSON：
{
  "decisions": [{ "what": "", "why": "", "alternatives": [""], "trigger": "", "date": "" }]
}`;

const PAIN_POINT_PROMPT = `你是一个问题模式提取器。只关注遇到的问题和解决方式。

分析以下 AI 编码对话，提取：
- 遇到了什么问题/错误？
- 怎么诊断的？
- 最终怎么解决的？
- 这个问题是否像是会反复出现的？

如果对话中没有明确问题，返回空数组。不要编造。

输出 JSON：
{
  "pain_points": [{ "problem": "", "diagnosis": "", "solution": "", "likely_recurring": false }]
}`;

const PREFERENCE_PROMPT = `你是一个工作风格观察器。只关注用户（非 AI）的行为模式。

分析以下对话，观察用户表现出的：
- 与 AI 的交互方式（指令式/讨论式/PRD 先行/代码先行）
- 对 AI 建议的反应（接受/修正/拒绝的模式）
- 技术审美（偏好简单/复杂、务实/完美主义）
- 沟通风格（简洁/详细、中文/英文切换）

只记录有证据支撑的观察。不要推测。

输出 JSON：
{
  "preferences": [{ "category": "", "observation": "", "evidence": "" }]
}`;

// ============================================================
// AI call — supports OpenAI-compatible (LiteLLM) and Anthropic native APIs
// ============================================================

async function callAI(
  systemPrompt: string,
  conversationText: string,
  config: Layer3Config,
): Promise<string | null> {
  const apiKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  const baseUrl = config.api_base_url || process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com';
  const model = config.model || 'anthropic/claude-haiku-4.5';

  if (!apiKey) return null;

  // Detect API format: if base URL is NOT api.anthropic.com, use OpenAI-compatible format (LiteLLM)
  const isAnthropicNative = baseUrl.includes('api.anthropic.com');

  try {
    let res: Response;

    if (isAnthropicNative) {
      // Anthropic Messages API
      res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: conversationText }],
        }),
      });
    } else {
      // OpenAI-compatible API (LiteLLM, etc.)
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: conversationText },
          ],
        }),
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`  AI API error: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();

    if (isAnthropicNative) {
      // Anthropic format: { content: [{ type: "text", text: "..." }] }
      const text = data.content?.find((c: { type: string; text?: string }) => c.type === 'text')?.text;
      return text ?? null;
    } else {
      // OpenAI format: { choices: [{ message: { content: "..." } }] }
      return data.choices?.[0]?.message?.content ?? null;
    }
  } catch (err) {
    console.error(`  AI call failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function parseJSON<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// ============================================================
// Format conversation for AI
// ============================================================

function formatConversation(messages: Message[], maxMessages: number = 20): string {
  const trimmed = messages.slice(0, maxMessages);
  return trimmed.map(m => {
    const prefix = m.role === 'user' ? 'User' : 'Assistant';
    const content = m.content.slice(0, 2000); // truncate long messages
    return `[${prefix}]: ${content}`;
  }).join('\n\n');
}

// ============================================================
// Layer 3 runner
// ============================================================

export async function runLayer3(
  registry: AdapterRegistry,
  noiseFilter: NoiseFilter,
  mergedProjects: MergedProject[],
  config: Layer3Config,
  alreadyProcessed: string[],
  sourceSummary: string,
  existingDecisions?: string,
  existingPainPoints?: string,
  existingWorkProfile?: string,
  previousDecisions?: Decision[],
  previousPainPoints?: PainPoint[],
  previousPreferences?: Preference[],
): Promise<Layer3Result> {
  const processedSet = new Set(alreadyProcessed);

  // Check if API key is available
  const apiKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('  No ANTHROPIC_API_KEY set. Skipping Layer 3 AI extraction.');
    return emptyResult(sourceSummary, existingDecisions, existingPainPoints, existingWorkProfile, previousDecisions, previousPainPoints, previousPreferences);
  }

  // Select high-value sessions
  const candidates = await selectHighValueSessions(registry, noiseFilter, mergedProjects, config, processedSet);
  console.log(`  High-value sessions found: ${candidates.length}`);

  if (candidates.length === 0) {
    return emptyResult(sourceSummary, existingDecisions, existingPainPoints, existingWorkProfile, previousDecisions, previousPainPoints, previousPreferences);
  }

  const allDecisions: Decision[] = [...(previousDecisions ?? [])];
  const allPainPoints: PainPoint[] = [...(previousPainPoints ?? [])];
  const allPreferences: Preference[] = [...(previousPreferences ?? [])];
  const processedIds: string[] = [...alreadyProcessed];
  const failedIds: string[] = [];

  // Process in batches of 5
  const batchSize = 5;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    console.log(`  Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(candidates.length / batchSize)} (${batch.length} sessions)...`);

    // Process batch concurrently
    const results = await Promise.allSettled(
      batch.map(async ({ session, projectName }) => {
        const sourceLabel = registry.getSourceLabel(session.source);
        const messages = await registry.getMessages(session);

        // Verify user message count > 5
        const userMsgCount = messages.filter(m => m.role === 'user').length;
        if (userMsgCount <= 5) return { sessionId: session.id, skipped: true };

        const conversation = formatConversation(messages);
        const dateStr = new Date(session.timeCreated).toISOString().split('T')[0];

        // Run 3 prompts
        const [decisionRes, painRes, prefRes] = await Promise.all([
          callAI(DECISION_PROMPT, conversation, config),
          callAI(PAIN_POINT_PROMPT, conversation, config),
          callAI(PREFERENCE_PROMPT, conversation, config),
        ]);

        // Parse decisions
        const decisionData = parseJSON<{ decisions: Array<{ what: string; why: string; alternatives: string[]; trigger: string; date: string }> }>(decisionRes);
        const decisions: Decision[] = (decisionData?.decisions ?? []).map(d => ({
          ...d,
          date: d.date || dateStr,
          sessionId: session.id,
          sessionTitle: session.title ?? '(untitled)',
          sourceLabel,
          projectName,
        }));

        // Parse pain points
        const painData = parseJSON<{ pain_points: Array<{ problem: string; diagnosis: string; solution: string; likely_recurring: boolean }> }>(painRes);
        const painPoints: PainPoint[] = (painData?.pain_points ?? []).map(p => ({
          ...p,
          sessionId: session.id,
          sessionTitle: session.title ?? '(untitled)',
          sourceLabel,
          projectName,
        }));

        // Parse preferences
        const prefData = parseJSON<{ preferences: Array<{ category: string; observation: string; evidence: string }> }>(prefRes);
        const preferences: Preference[] = prefData?.preferences ?? [];

        return { sessionId: session.id, decisions, painPoints, preferences, skipped: false };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const r = result.value;
        if (r.skipped) continue;
        if (r.decisions) allDecisions.push(...r.decisions);
        if (r.painPoints) allPainPoints.push(...r.painPoints);
        if (r.preferences) allPreferences.push(...r.preferences);
        processedIds.push(r.sessionId);
      } else {
        // Failed — record for retry
        failedIds.push('unknown');
        console.error(`  Session failed:`, result.reason);
      }
    }
  }

  // Render output files
  const decisionsContent = renderDecisions(allDecisions, sourceSummary, existingDecisions);
  const painPointsContent = renderPainPoints(allPainPoints, sourceSummary, existingPainPoints);
  const workProfileContent = renderWorkProfile(allPreferences, sourceSummary, existingWorkProfile);

  return {
    decisions: allDecisions,
    painPoints: allPainPoints,
    preferences: allPreferences,
    processedSessionIds: processedIds,
    failedSessionIds: failedIds,
    decisionsContent,
    painPointsContent,
    workProfileContent,
  };
}

function emptyResult(
  sourceSummary: string,
  existingDecisions?: string,
  existingPainPoints?: string,
  existingWorkProfile?: string,
  previousDecisions?: Decision[],
  previousPainPoints?: PainPoint[],
  previousPreferences?: Preference[],
): Layer3Result {
  return {
    decisions: previousDecisions ?? [],
    painPoints: previousPainPoints ?? [],
    preferences: previousPreferences ?? [],
    processedSessionIds: [],
    failedSessionIds: [],
    decisionsContent: renderDecisions(previousDecisions ?? [], sourceSummary, existingDecisions),
    painPointsContent: renderPainPoints(previousPainPoints ?? [], sourceSummary, existingPainPoints),
    workProfileContent: renderWorkProfile(previousPreferences ?? [], sourceSummary, existingWorkProfile),
  };
}

// ============================================================
// Rendering — PRD §6.1.2
// ============================================================

function fmtISO(d: Date = new Date()): string {
  return d.toISOString().replace('Z', '+00:00');
}

function fmtHeader(title: string, sourceSummary: string): string {
  return `<!-- generated: ${fmtISO()} -->\n<!-- sources: ${sourceSummary} -->\n# ${title}\n`;
}

function extractUserNotes(content?: string): string | null {
  if (!content) return null;
  const startTag = '<!-- user notes -->';
  const endTag = '<!-- /user notes -->';
  const si = content.indexOf(startTag);
  const ei = content.indexOf(endTag);
  if (si === -1 || ei === -1) return null;
  return content.slice(si, ei + endTag.length);
}

/** decisions.md — append-type, grouped by project → date */
function renderDecisions(decisions: Decision[], sourceSummary: string, _existing?: string): string {
  const lines: string[] = [];
  lines.push(fmtHeader('决策日志', sourceSummary));
  lines.push('');

  if (decisions.length === 0) {
    lines.push('*尚未提取到决策记录。*');
    lines.push('');
    return lines.join('\n');
  }

  // Group by project
  const byProject = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (!byProject.has(d.projectName)) byProject.set(d.projectName, []);
    byProject.get(d.projectName)!.push(d);
  }

  for (const [project, decs] of Array.from(byProject.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${project}`);
    lines.push('');

    // Sort by date
    decs.sort((a, b) => a.date.localeCompare(b.date));

    for (const d of decs) {
      lines.push(`### ${d.date}: ${d.what}`);
      if (d.trigger) lines.push(`- **背景**: ${d.trigger}`);
      if (d.alternatives.length > 0) lines.push(`- **考虑过的方案**: ${d.alternatives.join(', ')}`);
      lines.push(`- **决定**: ${d.what}`);
      lines.push(`- **理由**: ${d.why}`);
      lines.push(`- **来源**: session \`${d.sessionId}\` [${d.sourceLabel}] — "${d.sessionTitle}" (${d.date})`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** pain-points.md — append-type, grouped by problem */
function renderPainPoints(painPoints: PainPoint[], sourceSummary: string, _existing?: string): string {
  const lines: string[] = [];
  lines.push(fmtHeader('反复痛点', sourceSummary));
  lines.push('');

  if (painPoints.length === 0) {
    lines.push('*尚未提取到痛点记录。*');
    lines.push('');
    return lines.join('\n');
  }

  // Group similar problems (by exact problem text for now)
  const grouped = new Map<string, PainPoint[]>();
  for (const pp of painPoints) {
    const key = pp.problem.slice(0, 50);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(pp);
  }

  for (const [, points] of grouped) {
    const first = points[0];
    const projectCounts = new Map<string, number>();
    for (const p of points) {
      projectCounts.set(p.projectName, (projectCounts.get(p.projectName) ?? 0) + 1);
    }
    const projectSummary = Array.from(projectCounts.entries())
      .map(([name, count]) => `${name} ×${count}`)
      .join(', ');

    lines.push(`## ${first.problem}`);
    lines.push(`- **出现频率**: ${points.length} 次（${projectSummary}）`);
    lines.push(`- **典型症状**: ${first.problem}`);
    lines.push(`- **解决模式**: ${first.solution}`);
    lines.push(`- **可能反复**: ${first.likely_recurring ? 'yes' : 'no'}`);
    const sourceRefs = points.map(p => `session \`${p.sessionId}\` [${p.sourceLabel}] — "${p.sessionTitle}"`).join(', ');
    lines.push(`- **来源**: ${sourceRefs}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** work-profile.md — aggregate-type, AI-derived insights */
function renderWorkProfile(preferences: Preference[], sourceSummary: string, existing?: string): string {
  const userNotes = extractUserNotes(existing);
  const lines: string[] = [];
  lines.push(fmtHeader('工作画像', sourceSummary));
  lines.push('');

  if (preferences.length === 0) {
    lines.push('*尚未提取到工作偏好。*');
    lines.push('');
  } else {
    // Group by category
    const categories = new Map<string, Preference[]>();
    for (const p of preferences) {
      const cat = normalizeCategory(p.category);
      if (!categories.has(cat)) categories.set(cat, []);
      categories.get(cat)!.push(p);
    }

    const sectionOrder = ['交互风格', '语言偏好', '工作节奏', '技术审美', '其他'];
    const sortedCats = Array.from(categories.keys()).sort((a, b) => {
      const ia = sectionOrder.indexOf(a);
      const ib = sectionOrder.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    for (const cat of sortedCats) {
      lines.push(`## ${cat}`);
      // Deduplicate similar observations
      const seen = new Set<string>();
      for (const p of categories.get(cat)!) {
        const key = p.observation.slice(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`- ${p.observation} — *${p.evidence}*`);
      }
      lines.push('');
    }
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

function normalizeCategory(cat: string): string {
  const lower = cat.toLowerCase();
  if (/交互|interaction|style/i.test(lower)) return '交互风格';
  if (/语言|language/i.test(lower)) return '语言偏好';
  if (/节奏|rhythm|schedule|时间/i.test(lower)) return '工作节奏';
  if (/审美|aesthetic|技术.*偏好|preference/i.test(lower)) return '技术审美';
  if (/沟通|communication/i.test(lower)) return '交互风格';
  return cat;
}
