/**
 * Layer 3: Deep extraction (AI batch summary) — PRD §5.4
 * High-value session selection → 3 AI prompts per session → aggregate results
 * Generates: decisions.md, pain-points.md, work-profile.md
 */

import type { Session, Message, MergedProject } from '../adapters/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { NoiseFilter } from '../utils/noise-filter.js';
import { computeContentHash, type MemoryDecision, type MemoryPainPoint, type MemoryProfileEntry } from '../memory/types.js';

// ============================================================
// Types
// ============================================================

export interface Layer3Config {
  min_score: number;
  max_sessions: number;
  api_key?: string;
  api_base_url?: string;
  model?: string;
  consolidation_model?: string;  // stronger model for consolidation (e.g. sonnet)
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

class SessionProcessingError extends Error {
  readonly sessionId: string;
  readonly causeValue: unknown;

  constructor(sessionId: string, causeValue: unknown) {
    super(`Failed to process session ${sessionId}`);
    this.name = 'SessionProcessingError';
    this.sessionId = sessionId;
    this.causeValue = causeValue;
  }
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

/** Filter out subagent sessions (titles containing @ are delegated tasks, not human decisions) */
function isSubagentSession(session: Session): boolean {
  if (!session.title) return false;
  return /\(@\w+/.test(session.title) || /subagent\)/i.test(session.title);
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

      // Skip subagent sessions — delegated tasks, not human decision-making
      if (isSubagentSession(session)) continue;

      // Necessary condition: actually count user messages (not just proxy via messageCount)
      const messages = await registry.getMessages(session);
      const userMsgCount = messages.filter(m => m.role === 'user').length;
      if (userMsgCount <= 5) continue;

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
  modelOverride?: string,
  maxTokens: number = 2048,
): Promise<string | null> {
  const apiKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  const baseUrl = config.api_base_url || process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com';
  const model = modelOverride || config.model || 'anthropic/claude-haiku-4.5';

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
          max_tokens: maxTokens,
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
          max_tokens: maxTokens,
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

  const trimmedText = text.trim();
  const candidates = [trimmedText];
  const jsonMatch = trimmedText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    candidates.unshift(jsonMatch[1].trim());
  }

  const objectStart = trimmedText.indexOf('{');
  const objectEnd = trimmedText.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    candidates.push(trimmedText.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return null;
}

// ============================================================
// Format conversation for AI
// ============================================================

function formatConversation(messages: Message[], maxMessages: number = 20): string {
  const trimmed = messages.slice(0, Math.max(maxMessages, 1));
  return trimmed.map(m => {
    const prefix = m.role === 'user' ? 'User' : 'Assistant';
    const content = m.content.slice(0, 2000); // truncate long messages
    return `[${prefix}]: ${content}`;
  }).join('\n\n');
}

// ============================================================
// Layer 3 runner
// ============================================================

function computeDecisionHash(decision: Pick<Decision, 'what' | 'why' | 'alternatives' | 'trigger'>): string {
  return computeContentHash(JSON.stringify({
    what: decision.what.trim(),
    why: decision.why.trim(),
    alternatives: decision.alternatives.map((item) => item.trim()),
    trigger: decision.trigger.trim(),
  }));
}

function computePainPointHash(painPoint: Pick<PainPoint, 'problem' | 'diagnosis' | 'solution'>): string {
  return computeContentHash(JSON.stringify({
    problem: painPoint.problem.trim(),
    diagnosis: painPoint.diagnosis.trim(),
    solution: painPoint.solution.trim(),
  }));
}

function computePreferenceHash(preference: Pick<Preference, 'category' | 'observation' | 'evidence'>): string {
  return computeContentHash(JSON.stringify({
    category: preference.category.trim(),
    observation: preference.observation.trim(),
    evidence: preference.evidence.trim(),
  }));
}

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
  memoryDecisions?: MemoryDecision[],
  memoryPainPoints?: MemoryPainPoint[],
  memoryProfile?: MemoryProfileEntry[],
  memoryContentHashes?: string[],
): Promise<Layer3Result> {
  const processedSet = new Set(alreadyProcessed);

  // Check if API key is available
  const apiKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('  No ANTHROPIC_API_KEY set. Skipping Layer 3 AI extraction.');
    return emptyResult(sourceSummary, existingDecisions, existingPainPoints, existingWorkProfile, previousDecisions, previousPainPoints, previousPreferences, memoryDecisions, memoryPainPoints, memoryProfile, memoryContentHashes);
  }

  // Select high-value sessions
  const candidates = await selectHighValueSessions(registry, noiseFilter, mergedProjects, config, processedSet);
  console.log(`  High-value sessions found: ${candidates.length}`);

  if (candidates.length === 0) {
    return emptyResult(sourceSummary, existingDecisions, existingPainPoints, existingWorkProfile, previousDecisions, previousPainPoints, previousPreferences, memoryDecisions, memoryPainPoints, memoryProfile, memoryContentHashes);
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
        try {
          const sourceLabel = registry.getSourceLabel(session.source);
          const messages = await registry.getMessages(session);
          if (messages.length === 0) {
            return { sessionId: session.id, decisions: [], painPoints: [], preferences: [], skipped: true };
          }

          const conversation = formatConversation(messages);
          const dateStr = new Date(session.timeCreated).toISOString().split('T')[0];

          const [decisionRes, painRes, prefRes] = await Promise.all([
            callAI(DECISION_PROMPT, conversation, config),
            callAI(PAIN_POINT_PROMPT, conversation, config),
            callAI(PREFERENCE_PROMPT, conversation, config),
          ]);

          const decisionData = parseJSON<{ decisions: Array<{ what: string; why: string; alternatives: string[]; trigger: string; date: string }> }>(decisionRes);
          const decisions: Decision[] = (decisionData?.decisions ?? []).map(d => ({
            ...d,
            date: d.date || dateStr,
            sessionId: session.id,
            sessionTitle: session.title ?? '(untitled)',
            sourceLabel,
            projectName,
          }));

          const painData = parseJSON<{ pain_points: Array<{ problem: string; diagnosis: string; solution: string; likely_recurring: boolean }> }>(painRes);
          const painPoints: PainPoint[] = (painData?.pain_points ?? []).map(p => ({
            ...p,
            sessionId: session.id,
            sessionTitle: session.title ?? '(untitled)',
            sourceLabel,
            projectName,
          }));

          const prefData = parseJSON<{ preferences: Array<{ category: string; observation: string; evidence: string }> }>(prefRes);
          const preferences: Preference[] = prefData?.preferences ?? [];

          return { sessionId: session.id, decisions, painPoints, preferences, skipped: false };
        } catch (error) {
          throw new SessionProcessingError(session.id, error);
        }
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
        const sessionId = result.reason instanceof SessionProcessingError
          ? result.reason.sessionId
          : 'unknown';
        failedIds.push(sessionId);
        const error = result.reason instanceof SessionProcessingError
          ? result.reason.causeValue
          : result.reason;
        console.error(`  Session failed (${sessionId}):`, error);
      }
    }
  }

  // Consolidation: AI-powered dedup, filtering, and aggregation
  console.log(`  Consolidating results (${allDecisions.length} decisions, ${allPainPoints.length} pain points, ${allPreferences.length} preferences)...`);

  const [consolidatedDecisions, consolidatedPainPoints, consolidatedPreferences] = await Promise.all([
    consolidateDecisions(allDecisions, config),
    consolidatePainPoints(allPainPoints, config),
    consolidatePreferences(allPreferences, config),
  ]);

  const memoryHashSet = new Set(memoryContentHashes ?? []);
  const filteredDecisions = consolidatedDecisions.filter((decision) => !memoryHashSet.has(computeDecisionHash(decision)));
  const filteredPainPoints = consolidatedPainPoints.filter((painPoint) => !memoryHashSet.has(computePainPointHash(painPoint)));
  const filteredPreferences = consolidatedPreferences.filter((preference) => !memoryHashSet.has(computePreferenceHash(preference)));

  console.log(`  After consolidation: ${filteredDecisions.length} decisions, ${filteredPainPoints.length} pain points, ${filteredPreferences.length} preferences`);

  // Render output files
  const decisionsContent = renderDecisions(filteredDecisions, sourceSummary, existingDecisions, memoryDecisions);
  const painPointsContent = renderPainPoints(filteredPainPoints, sourceSummary, existingPainPoints, memoryPainPoints);
  const workProfileContent = renderWorkProfile(filteredPreferences, sourceSummary, existingWorkProfile, memoryProfile);

  return {
    decisions: filteredDecisions,
    painPoints: filteredPainPoints,
    preferences: filteredPreferences,
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
  memoryDecisions?: MemoryDecision[],
  memoryPainPoints?: MemoryPainPoint[],
  memoryProfile?: MemoryProfileEntry[],
  memoryContentHashes?: string[],
): Layer3Result {
  const memoryHashSet = new Set(memoryContentHashes ?? []);
  const decisions = (previousDecisions ?? []).filter((decision) => !memoryHashSet.has(computeDecisionHash(decision)));
  const painPoints = (previousPainPoints ?? []).filter((painPoint) => !memoryHashSet.has(computePainPointHash(painPoint)));
  const preferences = (previousPreferences ?? []).filter((preference) => !memoryHashSet.has(computePreferenceHash(preference)));

  return {
    decisions,
    painPoints,
    preferences,
    processedSessionIds: [],
    failedSessionIds: [],
    decisionsContent: renderDecisions(decisions, sourceSummary, existingDecisions, memoryDecisions),
    painPointsContent: renderPainPoints(painPoints, sourceSummary, existingPainPoints, memoryPainPoints),
    workProfileContent: renderWorkProfile(preferences, sourceSummary, existingWorkProfile, memoryProfile),
  };
}

// ============================================================
// Consolidation — AI-powered dedup, filtering, aggregation
// ============================================================

const CONSOLIDATE_DECISIONS_PROMPT = `你是一个决策日志编辑器。你的任务是从原始提取结果中筛选出真正的技术/产品决策。

**保留标准**（必须同时满足）：
1. 是真正的"选 A 不选 B"的决策，有被明确否决的替代方案
2. 是用户做出的决策（不是 AI 助手的操作，如切换模型、读取文件等）
3. 是架构/产品/技术选型级别的决策（不是具体代码细节，如"用 nanoid 生成 ID"这种）

**删除**：
- 任务描述伪装成决策（只是做了某事，没有真正的替代方案被考虑）
- AI 助手的操作（切换模型、读取文档）
- 代码实现细节（函数命名、索引创建等）
- alternatives 明显是 AI 捏造的（如"不做这件事"这种伪替代方案）

**合并**：同一 session 中关于同一主题的多个微决策合并为一个

输入是 JSON 数组，输出精炼后的 JSON 数组（保持相同结构）。只返回 JSON，不要解释。
输出格式：{ "decisions": [...] }`;

const CONSOLIDATE_PAIN_POINTS_PROMPT = `你是一个痛点分析编辑器。你的任务是聚合和筛选原始提取的痛点。

**删除**：
- AI 助手自身的故障（工具找不到、TODO 循环、prompt injection 检测）— 这些不是用户的工程痛点
- 功能需求伪装成痛点（"需要添加归档按钮"不是痛点）
- 系统指令/OH-MY-OPENCODE 相关的重复条目

**聚合**：
- 描述同一个技术问题的多条记录合并为一条，累加出现频率
- 合并后保留最好的诊断和解决方案描述
- 来源列出所有相关 session

**保留**：真正的工程技术问题（性能瓶颈、兼容性问题、配置难题、反复出现的 bug 等）

输入是 JSON 数组，输出精炼后的 JSON 数组。只返回 JSON。
输出格式：{ "pain_points": [...] }`;

const CONSOLIDATE_PREFERENCES_PROMPT = `你是一个用户画像编辑器。你需要把数百条重复、散乱的观察压缩成一份精炼的用户画像。

**目标**：8-12 个分类，每个分类 3-8 条不重复的观察，总计 40-60 条。

**必须使用的分类**（中文）：
- 交互风格（如何与 AI 对话）
- 语言偏好（中英文使用模式）
- 工作节奏（任务分解、迭代方式）
- 技术审美（简单 vs 复杂、务实 vs 完美）
- AI 协作模式（如何使用 AI、对 AI 的期望）
- 质量标准（对准确性、验证的要求）
- 需求表达（如何描述需求）
- 领域特征（涉及的技术/业务领域）

**规则**：
1. "用户使用中文"只说一次
2. 合并同义观察（"指令式交互"和"命令式交互"是同一个意思）
3. 如果有矛盾（如"讨论式"和"指令式"），合成为"复杂任务讨论式，简单任务指令式"
4. 删除关于 AI 自身行为的观察
5. 每条观察必须有具体 evidence，不能太抽象

输入是 JSON 数组，输出精炼后的 JSON 数组。只返回 JSON。
输出格式：{ "preferences": [{ "category": "分类名", "observation": "观察", "evidence": "证据" }] }`;

async function consolidateDecisions(decisions: Decision[], config: Layer3Config): Promise<Decision[]> {
  if (decisions.length === 0) return decisions;

  // Process per project to stay within context limits
  const byProject = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (!byProject.has(d.projectName)) byProject.set(d.projectName, []);
    byProject.get(d.projectName)!.push(d);
  }

  const result: Decision[] = [];
  for (const [projectName, decs] of byProject) {
    // Serialize decisions for AI (strip to essentials)
    const input = decs.map(d => ({
      what: d.what, why: d.why, alternatives: d.alternatives,
      trigger: d.trigger, date: d.date,
      sessionId: d.sessionId, sessionTitle: d.sessionTitle,
      sourceLabel: d.sourceLabel, projectName: d.projectName,
    }));

    const text = JSON.stringify(input, null, 0);
    // If small enough, skip consolidation
    if (decs.length <= 3) {
      result.push(...decs);
      continue;
    }

    const cModel = config.consolidation_model;
    const response = await callAI(CONSOLIDATE_DECISIONS_PROMPT, text, config, cModel, 8192);
    const parsed = parseJSON<{ decisions: Decision[] }>(response);
    if (parsed?.decisions) {
      // Restore projectName for all entries
      for (const d of parsed.decisions) d.projectName = projectName;
      result.push(...parsed.decisions);
    } else {
      result.push(...decs); // fallback: keep raw
    }
  }

  return result;
}

async function consolidatePainPoints(painPoints: PainPoint[], config: Layer3Config): Promise<PainPoint[]> {
  if (painPoints.length <= 5) return painPoints;

  // Process per project to stay within context limits
  const byProject = new Map<string, PainPoint[]>();
  for (const p of painPoints) {
    if (!byProject.has(p.projectName)) byProject.set(p.projectName, []);
    byProject.get(p.projectName)!.push(p);
  }

  const result: PainPoint[] = [];
  for (const [projectName, points] of byProject) {
    if (points.length <= 3) {
      result.push(...points);
      continue;
    }

    const input = points.map(p => ({
      problem: p.problem, diagnosis: p.diagnosis, solution: p.solution,
      likely_recurring: p.likely_recurring,
      sessionId: p.sessionId, sessionTitle: p.sessionTitle,
      sourceLabel: p.sourceLabel, projectName: p.projectName,
    }));

    const cModel = config.consolidation_model;
    const response = await callAI(CONSOLIDATE_PAIN_POINTS_PROMPT, JSON.stringify(input, null, 0), config, cModel, 8192);
    const parsed = parseJSON<{ pain_points: PainPoint[] }>(response);
    if (parsed?.pain_points) {
      for (const p of parsed.pain_points) p.projectName = projectName;
      result.push(...parsed.pain_points);
    } else {
      result.push(...points);
    }
  }

  return result;
}

async function consolidatePreferences(preferences: Preference[], config: Layer3Config): Promise<Preference[]> {
  if (preferences.length <= 10) return preferences;

  const input = preferences.map(p => ({
    category: p.category, observation: p.observation, evidence: p.evidence,
  }));

  const cModel = config.consolidation_model;
  const response = await callAI(CONSOLIDATE_PREFERENCES_PROMPT, JSON.stringify(input, null, 0), config, cModel, 8192);
  const parsed = parseJSON<{ preferences: Preference[] }>(response);
  return parsed?.preferences ?? preferences;
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
function renderDecisions(decisions: Decision[], sourceSummary: string, _existing?: string, memoryDecisions?: MemoryDecision[]): string {
  const lines: string[] = [];
  lines.push(fmtHeader('决策日志', sourceSummary));
  lines.push('');

  // Memory-derived decisions with stableId markers (PRD §4.5)
  if (memoryDecisions && memoryDecisions.length > 0) {
    const memByProject = new Map<string, MemoryDecision[]>();
    for (const d of memoryDecisions) {
      if (!memByProject.has(d.projectName)) memByProject.set(d.projectName, []);
      memByProject.get(d.projectName)!.push(d);
    }
    for (const [project, decs] of Array.from(memByProject.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`## ${project}`);
      lines.push('');
      for (const d of decs) {
        lines.push(`<!-- mem:${d.stableId} -->`);
        lines.push(`### ${d.date ?? 'unknown'}: ${d.what}`);
        if (d.trigger) lines.push(`- **背景**: ${d.trigger}`);
        if (d.alternatives && d.alternatives.length > 0) lines.push(`- **考虑过的方案**: ${d.alternatives.join(', ')}`);
        lines.push(`- **决定**: ${d.what}`);
        if (d.why) lines.push(`- **理由**: ${d.why}`);
        lines.push(`- **来源**: [${d.sourceLabel}] ${d.sourcePath}`);
        lines.push(`<!-- /mem:${d.stableId} -->`);
        lines.push('');
      }
    }
  }

  if (decisions.length === 0 && (!memoryDecisions || memoryDecisions.length === 0)) {
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
function renderPainPoints(painPoints: PainPoint[], sourceSummary: string, _existing?: string, memoryPainPoints?: MemoryPainPoint[]): string {
  const lines: string[] = [];
  lines.push(fmtHeader('反复痛点', sourceSummary));
  lines.push('');

  if (memoryPainPoints && memoryPainPoints.length > 0) {
    for (const mp of memoryPainPoints) {
      lines.push(`<!-- mem:${mp.stableId} -->`);
      lines.push(`## ${mp.problem}`);
      if (mp.diagnosis) lines.push(`- **典型症状**: ${mp.diagnosis}`);
      if (mp.solution) lines.push(`- **解决模式**: ${mp.solution}`);
      if (mp.likelyRecurring != null) lines.push(`- **可能反复**: ${mp.likelyRecurring ? 'yes' : 'no'}`);
      lines.push(`- **来源**: [${mp.sourceLabel}] ${mp.sourcePath}`);
      lines.push(`<!-- /mem:${mp.stableId} -->`);
      lines.push('');
    }
  }

  if (painPoints.length === 0 && (!memoryPainPoints || memoryPainPoints.length === 0)) {
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
    lines.push(`- **典型症状**: ${first.diagnosis}`);
    lines.push(`- **解决模式**: ${first.solution}`);
    lines.push(`- **可能反复**: ${first.likely_recurring ? 'yes' : 'no'}`);
    const sourceRefs = points.map(p => `session \`${p.sessionId}\` [${p.sourceLabel}] — "${p.sessionTitle}"`).join(', ');
    lines.push(`- **来源**: ${sourceRefs}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** work-profile.md — aggregate-type, AI-derived insights */
function renderWorkProfile(preferences: Preference[], sourceSummary: string, existing?: string, memoryProfile?: MemoryProfileEntry[]): string {
  const userNotes = extractUserNotes(existing);
  const lines: string[] = [];
  lines.push(fmtHeader('工作画像', sourceSummary));
  lines.push('');

  if (preferences.length === 0 && (!memoryProfile || memoryProfile.length === 0)) {
    lines.push('*尚未提取到工作偏好。*');
    lines.push('');
  } else {
    // Memory-derived profile entries (rendered first, higher fidelity)
    if (memoryProfile && memoryProfile.length > 0) {
      const memCategories = new Map<string, MemoryProfileEntry[]>();
      for (const p of memoryProfile) {
        const cat = normalizeCategory(p.category);
        if (!memCategories.has(cat)) memCategories.set(cat, []);
        memCategories.get(cat)!.push(p);
      }
      for (const [cat, entries] of memCategories) {
        lines.push(`## ${cat}（记忆来源）`);
        for (const e of entries) {
          const evidence = e.evidence && e.evidence !== e.observation ? ` — *${e.evidence}*` : '';
          lines.push(`- ${e.observation}${evidence} [${e.sourceLabel}]`);
        }
        lines.push('');
      }
    }

    // Session-derived preferences
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
