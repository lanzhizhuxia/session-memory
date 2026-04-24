import type { Decision, Preference } from '../../extractors/layer3.js';
import { computeContentHash, type MemoryDecision, type MemoryProfileEntry } from '../../memory/types.js';
import {
  computeCanonicalKey,
  computeFingerprint,
  type EvidenceRecord,
  type ProfileFactPayload,
  type SignalCandidate,
} from '../types.js';

// ============================================================
// AI Config
// ============================================================

export interface ProfileFactAIConfig {
  api_key: string;
  api_base_url: string;
  model: string;
}

export interface ProfileFactAIContext {
  projectNames: string[];
  decisionTopics: string[];
  focusAreaHits: Map<string, number>;
}

// ============================================================
// Constants
// ============================================================

const MAX_CLAIM_CHARS = 120;
const MAX_RATIONALE_CHARS = 180;
const MAX_ROLE_TITLE_CHARS = 30;

/** Keywords signaling role/position in observation text. */
const ROLE_KEYWORDS = /产品|开发|PM|engineer|量化|trader|前端|后端|全栈|设计|运营|研究|分析|manager|lead|架构|CTO|CEO|founder|负责人|技术总监|策略/i;

/** Keywords signaling responsibilities. */
const RESPONSIBILITY_KEYWORDS = /负责|推动|落地|方案|主导|管理|维护|搭建|设计|开发|对接|协调|优化|交付|owner|lead|drive/i;

/** Focus area domain-level keywords (not project names, not tech names). */
const FOCUS_AREA_KEYWORDS = /DeFi|套利|RWA|代币化|tokeniz|AI\s*Agent|知识库|量化交易|资金费率|funding\s*rate|企业内部工具|内部工具|会议记录|语音转录|加密货币|crypto|区块链|blockchain|交易系统|trading|meme|NFT|智能合约|smart\s*contract|数据分析|机器学习|web3|链上|on-?chain|做市|market\s*making/i;

/** Raw text / noise patterns to skip. */
const RAW_TEXT_LENGTH_THRESHOLD = 200;
const MARKDOWN_NOISE_PATTERN = /```|^\s*[-*+]\s+.+\n\s*[-*+]\s+|^\|.*\|$/m;
const AI_BEHAVIOR_PATTERN = /AI\s*助手|Claude|系统提示|model\s+behavior|system\s+prompt/i;
const PROJECT_DESCRIPTION_PATTERN = /这个项目|本项目|项目的核心价值|项目价值/i;
const LONG_SENTENCE_PATTERN = /[。！？；]/;
const ROLE_SENTENCE_NOISE_PATTERN = /的|是|在|了|等/;
const FOCUS_LEAD_IN_PATTERN = /^涉及.{8,}/;
const ROLE_TASK_VERB_PATTERN = /验证|修复|处理|跟进|推进|上线/;

const FOCUS_DOMAIN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'DeFi', pattern: /DeFi|套利|arbitrage|对冲|DEX|swap|流动性挖矿|liquidity/i },
  { label: 'RWA 代币化', pattern: /RWA|代币化|tokeniz|Ondo|美股.*链上|链上.*美股|coin.*stock|stock.*token/i },
  { label: 'AI 工具链', pattern: /\bLLM\b|MCP|multi.?agent|toolchain|RAG|prompt\s*engineer|\bGPT\b|opencode|openclaw|智能代理|AI\s*Agent/i },
  { label: '量化交易', pattern: /量化交易|量化|quant|trading\s*system|回测|backtest/i },
  { label: '资金费率套利', pattern: /资金费率|funding\s*rate|funding\s*arb/i },
  { label: '知识库', pattern: /知识库|knowledge\s*base|知识检索|知识助手/i },
  { label: '预测市场', pattern: /预测市场|prediction\s*market|polymarket|forecast/i },
  { label: '个人能效工具', pattern: /session.?memory|数字分身|个人工具|能效工具|productivity|笔记|转录|会议记录/i },
  { label: '语音转录', pattern: /语音转录|whisper|transcri/i },
  { label: '加密货币', pattern: /加密货币|crypto|区块链|blockchain|链上|on.?chain|web3/i },
  { label: 'Meme 交易', pattern: /meme|pump\.fun|four\.meme/i },
  { label: '风控', pattern: /风控|risk\s*control|risk\s*management/i },
  { label: '交易基础设施', pattern: /交易系统|撮合|exchange|trading\s*infra|broker|保证金/i },
  { label: '项目管理', pattern: /PRD|需求文档|项目管理|OKR|roadmap|里程碑|milestone|sprint/i },
];

const RESPONSIBILITY_THEME_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '量化交易系统产品化', pattern: /量化|quant|trading|交易系统|回测|策略/i },
  { label: '资金费率套利策略设计', pattern: /资金费率|funding|套利|arbitrage/i },
  { label: '知识库助手建设', pattern: /知识库|knowledge\s*base|search|检索|PRD/i },
  { label: 'AI 工具链建设', pattern: /\bLLM\b|MCP|multi.?agent|agent|opencode|openclaw|davidbot|toolchain|RAG|智能代理|知识助手/i },
  { label: '语音转录与会议记录', pattern: /转录|whisper|语音|会议/i },
  { label: '风控体系建设', pattern: /风控|risk/i },
  { label: 'RWA 代币化方案', pattern: /RWA|代币化|tokeniz/i },
  { label: '交易基础设施建设', pattern: /撮合|交易基础设施|exchange|api|gateway/i },
  { label: '企业内部工具落地', pattern: /内部工具|企业.*工具|bot|助手/i },
];

// ============================================================
// Helpers
// ============================================================

function clamp(value: string, maxChars: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return trimmed;
  const punctuation = ['。', '！', '？', '.', '!', '?', '；', ';'];
  let bestCut = -1;
  for (const mark of punctuation) {
    const idx = trimmed.lastIndexOf(mark, maxChars);
    if (idx > bestCut) bestCut = idx + 1;
  }
  const softPunctuation = ['，', ',', '、', '：', ':'];
  let softCut = -1;
  for (const mark of softPunctuation) {
    const idx = trimmed.lastIndexOf(mark, maxChars);
    if (idx > softCut) softCut = idx + 1;
  }
  const spaceCut = trimmed.lastIndexOf(' ', maxChars);
  const threshold = Math.floor(maxChars * 0.5);
  if (bestCut > threshold) return trimmed.slice(0, bestCut).trim();
  if (softCut > threshold) return trimmed.slice(0, softCut).trim();
  if (spaceCut > threshold) return trimmed.slice(0, spaceCut).trim();
  return `${trimmed.slice(0, maxChars - 1).trim()}…`;
}

function isRawChatText(text: string): boolean {
  if (text.length > RAW_TEXT_LENGTH_THRESHOLD) return true;
  if (MARKDOWN_NOISE_PATTERN.test(text)) return true;
  return false;
}

function shouldRejectMemorySentence(text: string): boolean {
  if (PROJECT_DESCRIPTION_PATTERN.test(text)) return true;
  if (FOCUS_LEAD_IN_PATTERN.test(text)) return true;
  if (LONG_SENTENCE_PATTERN.test(text)) return true;
  return false;
}

function isClearRoleTitle(claim: string): boolean {
  if (claim.length === 0 || claim.length > MAX_ROLE_TITLE_CHARS) return false;
  if (claim.length > 30) return false;
  if (ROLE_SENTENCE_NOISE_PATTERN.test(claim)) return false;
  if (/[，,。:：；]/.test(claim)) return false;
  return true;
}

export function extractFocusDomainLabels(text: string): string[] {
  const labels: string[] = [];
  for (const domain of FOCUS_DOMAIN_PATTERNS) {
    if (domain.pattern.test(text)) {
      labels.push(domain.label);
    }
  }
  return labels;
}

function inferResponsibilityTheme(project: string, texts: string[]): string | null {
  const hits = RESPONSIBILITY_THEME_PATTERNS
    .map((theme) => ({
      label: theme.label,
      count: texts.reduce((total, text) => total + (theme.pattern.test(text) ? 1 : 0), 0),
    }))
    .filter((theme) => theme.count > 0)
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));

  if (hits.length > 0) {
    return `${project} ${hits[0].label}`;
  }

  const conciseTheme = texts
    .map((text) => text.trim())
    .find((text) => text.length > 0 && text.length <= 24 && !shouldRejectMemorySentence(text));

  return conciseTheme ? `${project} ${conciseTheme}` : null;
}

function buildEvidenceId(prefix: string, stableKey: string): string {
  return computeContentHash(`${prefix}:${stableKey}`);
}

function normalizeProjectToken(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').trim();
}

function containsProjectName(text: string, projectNames: string[]): boolean {
  const normalizedText = normalizeProjectToken(text);
  if (normalizedText.length === 0) return false;

  return projectNames.some((projectName) => {
    const normalizedProject = normalizeProjectToken(projectName);
    return normalizedProject.length >= 3 && normalizedText.includes(normalizedProject);
  });
}

function formatFocusAreaHits(focusAreaHits: Map<string, number>): string {
  const items = [...focusAreaHits.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => `${label}(${count}次)`);
  return items.length > 0 ? items.join('，') : '(none)';
}

function buildProfileAIUserInput(
  observations: string[],
  context: ProfileFactAIContext,
): string {
  const focusHitsSorted = [...context.focusAreaHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const aiRelatedCount = focusHitsSorted
    .filter(([label]) => /AI|LLM|MCP|agent|toolchain|知识库/i.test(label))
    .reduce((sum, [, count]) => sum + count, 0);
  const totalHits = focusHitsSorted.reduce((sum, [, count]) => sum + count, 0);

  const lines = [
    '你正在分析一个人的长期工作画像。根据以下所有信息源，推断此人的完整职业身份。',
    '注意：记忆文件可能不完整，请务必结合项目分布、决策主题和领域分布做综合判断。',
    '',
    '工作记录摘要（过去 6-12 个月）：',
    `- 活跃项目：${context.projectNames.length > 0 ? context.projectNames.join(', ') : '(none)'}`,
    `- 主要决策主题：${context.decisionTopics.length > 0 ? context.decisionTopics.join('，') : '(none)'}`,
    `- 领域分布：${formatFocusAreaHits(context.focusAreaHits)}`,
  ];

  if (totalHits > 0 && aiRelatedCount > 0) {
    const aiPercent = Math.round((aiRelatedCount / totalHits) * 100);
    lines.push(`- AI/工具链相关决策占比：约 ${aiPercent}%`);
  }

  lines.push('', '用户记忆文件中的观察：');
  lines.push(...observations.map((observation, index) => `${index + 1}. ${observation}`));

  return lines.join('\n');
}

function buildCandidateFromPayload(
  payload: ProfileFactPayload,
  evidence: EvidenceRecord,
  extractor: string,
  confidence: number,
): SignalCandidate {
  const candidate: SignalCandidate = {
    id: computeContentHash(`${evidence.id}:pf:${payload.dimension}:${payload.claim}`),
    kind: 'profile_fact',
    evidenceIds: [evidence.id],
    primaryEvidenceId: evidence.id,
    confidence,
    trustScore: evidence.trustScore,
    sourceLabels: [evidence.sourceLabel],
    observedAt: evidence.observedAt,
    extractor,
    rawText: evidence.content,
    payload,
  };

  candidate.fingerprint = computeFingerprint(candidate.kind, candidate.payload);
  candidate.canonicalKeyHint = computeCanonicalKey(candidate);
  return candidate;
}

// ============================================================
// Dimension: role — from memory profile entries
// ============================================================

function extractRolesFromMemory(
  entries: MemoryProfileEntry[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const entry of entries) {
    const observation = entry.observation?.trim() ?? '';
    if (observation.length === 0) continue;
    if (!ROLE_KEYWORDS.test(observation)) continue;
    if (isRawChatText(observation)) continue;
    if (AI_BEHAVIOR_PATTERN.test(observation)) continue;
    if (shouldRejectMemorySentence(observation)) continue;
    if (!isClearRoleTitle(observation)) continue;

    const trustScore: 1 | 2 | 3 | 4 | 5 = entry.sourceLabel === 'rule' ? 5 : 4;

    const evidenceId = buildEvidenceId('memory-profile-role', `${entry.stableId}:${observation}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'memory_file',
      sourceLabel: entry.sourceLabel,
      filePath: entry.sourcePath,
      content: observation,
      contentHash: computeContentHash(`role:${entry.stableId}:${observation}`),
      capturedAt: Date.now(),
      trustScore,
      recencyScore: 1,
      extractionHints: ['profile-fact', 'role'],
      metadata: { stableId: entry.stableId },
    };

    const payload: ProfileFactPayload = {
      dimension: 'role',
      claim: clamp(observation, MAX_CLAIM_CHARS),
      scope: 'global',
      rationale: entry.evidence && entry.evidence !== observation
        ? clamp(entry.evidence, MAX_RATIONALE_CHARS)
        : undefined,
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer0-memory-profile-fact', 0.85));
  }

  return { candidates, evidence };
}

// ============================================================
// Dimension: role — inferred from Layer 3 decisions
// ============================================================

function inferRoleFromDecisions(
  decisions: Decision[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  if (decisions.length < 3) return { candidates, evidence };

  // Classify decisions by domain
  const productKeywords = /产品|PRD|需求|用户体验|布局|UI|UX|交互|功能|模块|页面|feature|triage|schedule/i;
  const techKeywords = /架构|重构|迁移|部署|数据库|schema|API|性能|算法|SDK|pipeline|encoding|分轨|转录/i;
  const quantKeywords = /量化|套利|资金费率|funding|对冲|hedge|交易|trading|持仓|仓位|做市|Binance|DEX|swap/i;
  const aiKeywords = /\bLLM\b|MCP|agent|multi.?agent|toolchain|RAG|prompt|opencode|openclaw|知识库|assistant|智能|模型路由|embedding/i;

  let productCount = 0;
  let techCount = 0;
  let quantCount = 0;
  let aiCount = 0;

  for (const d of decisions) {
    const combined = `${d.what} ${d.why} ${d.trigger}`;
    if (productKeywords.test(combined)) productCount++;
    if (techKeywords.test(combined)) techCount++;
    if (quantKeywords.test(combined)) quantCount++;
    if (aiKeywords.test(combined)) aiCount++;
  }

  const total = decisions.length;
  const roleParts: string[] = [];

  if (productCount / total >= 0.2) roleParts.push('产品经理');
  if (techCount / total >= 0.2) roleParts.push('开发者');
  if (quantCount / total >= 0.1) roleParts.push('量化开发者');
  if (aiCount / total >= 0.1) roleParts.push('AI工具链开发者');

  if (roleParts.length === 0) return { candidates, evidence };

  const roleClaim = roleParts.join('兼');
  const rationale = `基于${total}条决策记录推断：产品${productCount}条、技术${techCount}条、量化${quantCount}条、AI${aiCount}条`;

  const evidenceId = buildEvidenceId('layer3-decision-role', roleClaim);
  const evidenceRecord: EvidenceRecord = {
    id: evidenceId,
    sourceKind: 'derived_note',
    sourceLabel: 'layer3-ai',
    content: rationale,
    contentHash: computeContentHash(`decision-role:${roleClaim}:${total}`),
    capturedAt: Date.now(),
    trustScore: 3,
    recencyScore: 0.7,
    extractionHints: ['profile-fact', 'role'],
  };

  const payload: ProfileFactPayload = {
    dimension: 'role',
    claim: clamp(roleClaim, MAX_CLAIM_CHARS),
    scope: 'global',
    rationale: clamp(rationale, MAX_RATIONALE_CHARS),
  };

  evidence.push(evidenceRecord);
  candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer3-bridge-profile-fact', 0.65));

  return { candidates, evidence };
}

// ============================================================
// Dimension: responsibility — from memory + decisions
// ============================================================

function extractResponsibilitiesFromMemory(
  entries: MemoryProfileEntry[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const entry of entries) {
    const observation = entry.observation?.trim() ?? '';
    if (observation.length === 0) continue;
    if (!RESPONSIBILITY_KEYWORDS.test(observation)) continue;
    if (isRawChatText(observation)) continue;
    if (AI_BEHAVIOR_PATTERN.test(observation)) continue;
    if (shouldRejectMemorySentence(observation)) continue;

    const trustScore: 1 | 2 | 3 | 4 | 5 = entry.sourceLabel === 'rule' ? 5 : 4;

    const evidenceId = buildEvidenceId('memory-profile-resp', `${entry.stableId}:${observation}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'memory_file',
      sourceLabel: entry.sourceLabel,
      filePath: entry.sourcePath,
      content: observation,
      contentHash: computeContentHash(`resp:${entry.stableId}:${observation}`),
      capturedAt: Date.now(),
      trustScore,
      recencyScore: 1,
      extractionHints: ['profile-fact', 'responsibility'],
      metadata: { stableId: entry.stableId },
    };

    const payload: ProfileFactPayload = {
      dimension: 'responsibility',
      claim: clamp(observation, MAX_CLAIM_CHARS),
      scope: 'global',
      rationale: entry.evidence && entry.evidence !== observation
        ? clamp(entry.evidence, MAX_RATIONALE_CHARS)
        : undefined,
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer0-memory-profile-fact', 0.8));
  }

  return { candidates, evidence };
}

function inferResponsibilitiesFromDecisions(
  layer3Decisions: Decision[],
  memoryDecisions: MemoryDecision[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  // Group decisions by project to infer per-project responsibility
  const projectDecisions = new Map<string, { count: number; themes: string[] }>();

  for (const d of layer3Decisions) {
    const project = d.projectName?.trim();
    if (!project) continue;
    if (!projectDecisions.has(project)) {
      projectDecisions.set(project, { count: 0, themes: [] });
    }
    const entry = projectDecisions.get(project)!;
    entry.count++;
    const what = d.what.trim();
    if (what.length > 0 && what.length <= 80) {
      entry.themes.push(what);
    }
  }

  for (const md of memoryDecisions) {
    const project = md.projectName?.trim();
    if (!project) continue;
    if (!projectDecisions.has(project)) {
      projectDecisions.set(project, { count: 0, themes: [] });
    }
    const entry = projectDecisions.get(project)!;
    entry.count++;
    const what = md.what.trim();
    if (what.length > 0 && what.length <= 80) {
      entry.themes.push(what);
    }
  }

  const topProjects = [...projectDecisions.entries()]
    .filter(([, data]) => data.count >= 3)
    .sort(([leftProject, left], [rightProject, right]) => (
      right.count - left.count || leftProject.localeCompare(rightProject)
    ))
    .slice(0, 3);

  for (const [project, data] of topProjects) {
    const claim = inferResponsibilityTheme(project, data.themes);
    if (claim == null) continue;

    const rationale = `${project}项目中有${data.count}条相关决策记录`;

    const evidenceId = buildEvidenceId('layer3-decision-resp', `${project}:${data.count}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'derived_note',
      sourceLabel: 'layer3-ai',
      projectName: project,
      content: `${project}: ${data.count} decisions`,
      contentHash: computeContentHash(`resp:${project}:${data.count}`),
      capturedAt: Date.now(),
      trustScore: 3,
      recencyScore: 0.7,
      extractionHints: ['profile-fact', 'responsibility'],
      metadata: { projectName: project, decisionCount: data.count },
    };

    const payload: ProfileFactPayload = {
      dimension: 'responsibility',
      claim: clamp(claim, MAX_CLAIM_CHARS),
      scope: 'project',
      rationale: clamp(rationale, MAX_RATIONALE_CHARS),
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer3-bridge-profile-fact', 0.6));
  }

  return { candidates, evidence };
}

// ============================================================
// Dimension: focus_area — from decisions + preferences + memory
// ============================================================

function extractFocusAreasFromDecisions(
  layer3Decisions: Decision[],
  memoryDecisions: MemoryDecision[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  // Scan all decisions for domain-level keywords
  const domainHits = new Map<string, number>();
  const allTexts: string[] = [];

  for (const d of layer3Decisions) {
    allTexts.push(`${d.what} ${d.why} ${d.trigger}`);
  }
  for (const md of memoryDecisions) {
    allTexts.push(`${md.what} ${md.why ?? ''} ${md.trigger ?? ''}`);
  }

  for (const text of allTexts) {
    for (const dp of FOCUS_DOMAIN_PATTERNS) {
      if (dp.pattern.test(text)) {
        domainHits.set(dp.label, (domainHits.get(dp.label) ?? 0) + 1);
      }
    }
  }

  // Only emit focus areas that appear 2+ times across decisions
  const sortedDomains = Array.from(domainHits.entries())
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  for (const [domain, count] of sortedDomains) {
    const rationale = `在${count}条决策/记录中出现相关主题`;

    const evidenceId = buildEvidenceId('layer3-focus', `${domain}:${count}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'derived_note',
      sourceLabel: 'layer3-ai',
      content: `focus area: ${domain} (${count} occurrences)`,
      contentHash: computeContentHash(`focus:${domain}:${count}`),
      capturedAt: Date.now(),
      trustScore: 3,
      recencyScore: 0.7,
      extractionHints: ['profile-fact', 'focus_area'],
      metadata: { domain, hitCount: count },
    };

    const payload: ProfileFactPayload = {
      dimension: 'focus_area',
      claim: domain,
      scope: 'global',
      rationale: clamp(rationale, MAX_RATIONALE_CHARS),
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer3-bridge-profile-fact', 0.65));
  }

  return { candidates, evidence };
}

function extractFocusAreasFromMemory(
  entries: MemoryProfileEntry[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const entry of entries) {
    const observation = entry.observation?.trim() ?? '';
    if (observation.length === 0) continue;
    if (!FOCUS_AREA_KEYWORDS.test(observation)) continue;
    if (isRawChatText(observation)) continue;
    if (AI_BEHAVIOR_PATTERN.test(observation)) continue;
    if (shouldRejectMemorySentence(observation) && extractFocusDomainLabels(observation).length === 0) continue;

    const domains = extractFocusDomainLabels(observation);
    if (domains.length === 0) continue;

    const trustScore: 1 | 2 | 3 | 4 | 5 = entry.sourceLabel === 'rule' ? 5 : 4;

    for (const domain of domains) {
      const evidenceId = buildEvidenceId('memory-profile-focus', `${entry.stableId}:${domain}`);
      const evidenceRecord: EvidenceRecord = {
        id: evidenceId,
        sourceKind: 'memory_file',
        sourceLabel: entry.sourceLabel,
        filePath: entry.sourcePath,
        content: observation,
        contentHash: computeContentHash(`focus:${entry.stableId}:${domain}`),
        capturedAt: Date.now(),
        trustScore,
        recencyScore: 1,
        extractionHints: ['profile-fact', 'focus_area'],
        metadata: { stableId: entry.stableId, domain },
      };

      const payload: ProfileFactPayload = {
        dimension: 'focus_area',
        claim: domain,
        scope: 'global',
        rationale: entry.evidence && entry.evidence !== observation
          ? clamp(entry.evidence, MAX_RATIONALE_CHARS)
          : undefined,
      };

      evidence.push(evidenceRecord);
      candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer0-memory-profile-fact', 0.8));
    }
  }

  return { candidates, evidence };
}

function extractFocusAreasFromPreferences(
  preferences: Preference[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  // Only look at "领域特征" category preferences
  const domainPrefs = preferences.filter((p) => /领域|domain|focus/i.test(p.category?.trim() ?? ''));

  for (const pref of domainPrefs) {
    const observation = pref.observation?.trim() ?? '';
    if (observation.length === 0) continue;
    if (isRawChatText(observation)) continue;
    if (AI_BEHAVIOR_PATTERN.test(observation)) continue;
    if (shouldRejectMemorySentence(observation) && extractFocusDomainLabels(observation).length === 0) continue;

    const domains = extractFocusDomainLabels(observation);
    if (domains.length === 0) continue;

    for (const domain of domains) {
      const evidenceId = buildEvidenceId('layer3-pref-focus', `${pref.category}:${domain}`);
      const evidenceRecord: EvidenceRecord = {
        id: evidenceId,
        sourceKind: 'session_message',
        sourceLabel: 'layer3-ai',
        content: observation,
        contentHash: computeContentHash(`focus-pref:${pref.category}:${domain}`),
        capturedAt: Date.now(),
        trustScore: 3,
        recencyScore: 0.7,
        extractionHints: ['profile-fact', 'focus_area'],
        metadata: { originalCategory: pref.category, domain },
      };

      const payload: ProfileFactPayload = {
        dimension: 'focus_area',
        claim: domain,
        scope: 'global',
        rationale: pref.evidence && pref.evidence !== observation
          ? clamp(pref.evidence, MAX_RATIONALE_CHARS)
          : undefined,
      };

      evidence.push(evidenceRecord);
      candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer3-bridge-profile-fact', 0.65));
    }
  }

  return { candidates, evidence };
}

// ============================================================
// AI-backed semantic extraction for memory profile entries
// ============================================================

const PROFILE_SYSTEM_PROMPT = `You are analyzing a user's work profile observations from their coding assistant memory files.
Extract a structured profile from these observations. Output ONLY valid JSON, no explanation.

Schema:
{
  "role": "specific compound role with domain qualifiers, max 30 chars, e.g. 区块链产品经理兼AI工具链开发者",
  "responsibilities": ["2-3 recurring responsibilities, each max 30 chars"],
  "focus_areas": ["5-8 short domain labels, each max 15 chars, must cover ALL major work domains"]
}

Rules:
- IMPORTANT: Memory observations may be incomplete. You MUST weigh ALL evidence sources equally:
  project distribution, decision topics, AND domain distribution, not just memory text.
- role must reflect ALL major dimensions of the user's work, expressed as a compound identity
  e.g. if user does both crypto product management AND AI toolchain development, say both
- role must include domain qualifiers, NOT generic titles like bare 产品经理 or 开发者
- responsibilities must describe recurring responsibilities, NOT this week's concrete tasks
- do not mention concrete project names in role or responsibilities
- do not use execution-task verbs such as 验证, 修复, 处理, 跟进, 推进, 上线 in role
- focus_areas must include ALL domains that appear in the evidence, even low-frequency ones
- focus_areas are better too many than too few — downstream consumers need comprehensive coverage
- if evidence is insufficient for any field, omit it instead of guessing`;

interface AIProfileResult {
  role?: string;
  responsibilities?: string[];
  focus_areas?: string[];
}

function normalizeProfileResult(raw: unknown): AIProfileResult | null {
  if (raw == null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const role = typeof obj.role === 'string' ? obj.role.trim() : undefined;

  let responsibilities: string[] | undefined;
  if (Array.isArray(obj.responsibilities)) {
    responsibilities = obj.responsibilities
      .filter((item): item is string => typeof item === 'string')
      .map(s => s.trim())
      .filter(Boolean);
    if (responsibilities.length === 0) responsibilities = undefined;
  }

  let focus_areas: string[] | undefined;
  if (Array.isArray(obj.focus_areas)) {
    focus_areas = obj.focus_areas
      .filter((item): item is string => typeof item === 'string')
      .map(s => s.trim())
      .filter(Boolean);
    if (focus_areas.length === 0) focus_areas = undefined;
  }

  if (!role && !responsibilities && !focus_areas) return null;
  return { role: role || undefined, responsibilities, focus_areas };
}

const MAX_AI_RETRIES = 2;
const AI_RETRY_BASE_MS = 1000;

async function callProfileAI(
  observations: string[],
  config: ProfileFactAIConfig,
  context: ProfileFactAIContext,
): Promise<AIProfileResult | null> {
  const input = buildProfileAIUserInput(observations, context);

  for (let attempt = 0; attempt <= MAX_AI_RETRIES; attempt++) {
    try {
      const res = await fetch(`${config.api_base_url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 512,
          temperature: 0,
          messages: [
            { role: 'system', content: PROFILE_SYSTEM_PROMPT },
            { role: 'user', content: input },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_AI_RETRIES) {
          const delayMs = AI_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        console.error(`  Profile AI error: ${res.status} ${body.slice(0, 200)}`);
        return null;
      }

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (text.length === 0) return null;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      return normalizeProfileResult(JSON.parse(jsonMatch[0]));
    } catch (err) {
      if (attempt < MAX_AI_RETRIES) {
        const delayMs = AI_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      console.error(`  Profile AI failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  return null;
}

function isValidRole(role: string, projectNames: string[]): boolean {
  if (role.length === 0 || role.length > MAX_ROLE_TITLE_CHARS) return false;
  if (LONG_SENTENCE_PATTERN.test(role)) return false;
  if (PROJECT_DESCRIPTION_PATTERN.test(role)) return false;
  if (ROLE_TASK_VERB_PATTERN.test(role)) return false;
  if (containsProjectName(role, projectNames)) return false;
  const TOO_GENERIC = /^(产品经理|开发者|工程师|设计师|PM|engineer|developer)$/i;
  if (TOO_GENERIC.test(role.trim())) return false;
  return true;
}

function isValidResponsibility(resp: string, projectNames: string[]): boolean {
  return resp.length > 0
    && resp.length <= 30
    && !LONG_SENTENCE_PATTERN.test(resp)
    && !containsProjectName(resp, projectNames);
}

function isValidFocusArea(area: string): boolean {
  return area.length > 0 && area.length <= 15 && !LONG_SENTENCE_PATTERN.test(area);
}

async function extractProfileFactsWithAI(
  memoryProfileEntries: MemoryProfileEntry[],
  config: ProfileFactAIConfig,
  context: ProfileFactAIContext,
): Promise<{ candidates: SignalCandidate[]; evidence: EvidenceRecord[] }> {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  const observations = memoryProfileEntries
    .map((e) => e.observation?.trim() ?? '')
    .filter((obs) => obs.length > 0 && obs.length < RAW_TEXT_LENGTH_THRESHOLD);

  if (observations.length === 0) return { candidates, evidence };

  const result = await callProfileAI(observations, config, context);
  if (result == null) return { candidates, evidence };

  const evidenceId = buildEvidenceId('ai-profile-semantic', observations.join('|'));
  const evidenceRecord: EvidenceRecord = {
    id: evidenceId,
    sourceKind: 'memory_file',
    sourceLabel: 'memory-ai-semantic',
    content: observations.join(' | '),
    contentHash: computeContentHash(`ai-profile:${observations.join('|')}`),
    capturedAt: Date.now(),
    trustScore: 4,
    recencyScore: 1,
    extractionHints: ['profile-fact', 'ai-semantic'],
  };
  evidence.push(evidenceRecord);

  if (result.role != null && isValidRole(result.role, context.projectNames)) {
    const payload: ProfileFactPayload = {
      dimension: 'role',
      claim: clamp(result.role, MAX_CLAIM_CHARS),
      scope: 'global',
    };
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-ai-semantic-profile-fact', 0.9));
  }

  if (result.responsibilities != null) {
    for (const resp of result.responsibilities.slice(0, 3)) {
      if (!isValidResponsibility(resp, context.projectNames)) continue;
      const payload: ProfileFactPayload = {
        dimension: 'responsibility',
        claim: clamp(resp, MAX_CLAIM_CHARS),
        scope: 'global',
      };
      candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-ai-semantic-profile-fact', 0.85));
    }
  }

  if (result.focus_areas != null) {
    for (const area of result.focus_areas.slice(0, 8)) {
      if (!isValidFocusArea(area)) continue;
      const payload: ProfileFactPayload = {
        dimension: 'focus_area',
        claim: clamp(area, MAX_CLAIM_CHARS),
        scope: 'global',
      };
      candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-ai-semantic-profile-fact', 0.85));
    }
  }

  const aiFocusSet = new Set((result.focus_areas ?? []).map((a) => a.trim().toLowerCase()));
  for (const [label, count] of context.focusAreaHits.entries()) {
    if (count < 2) continue;
    if (aiFocusSet.has(label.trim().toLowerCase())) continue;
    if (!isValidFocusArea(label)) continue;
    const payload: ProfileFactPayload = {
      dimension: 'focus_area',
      claim: clamp(label, MAX_CLAIM_CHARS),
      scope: 'global',
    };
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-ai-semantic-profile-fact-supplement', 0.7));
  }

  return { candidates, evidence };
}

// ============================================================
// Public API
// ============================================================

export async function extractProfileFactCandidates(
  layer3Preferences: Preference[],
  layer3Decisions: Decision[],
  memoryProfileEntries: MemoryProfileEntry[],
  memoryDecisions: MemoryDecision[],
  aiConfig?: ProfileFactAIConfig,
  aiContext: ProfileFactAIContext = { projectNames: [], decisionTopics: [], focusAreaHits: new Map() },
): Promise<{ candidates: SignalCandidate[]; evidence: EvidenceRecord[] }> {
  // AI-backed semantic extraction (replaces regex-based memory extraction when available)
  const aiProfileFacts = aiConfig != null
    ? await extractProfileFactsWithAI(memoryProfileEntries, aiConfig, aiContext)
    : { candidates: [] as SignalCandidate[], evidence: [] as EvidenceRecord[] };
  const hasAIResults = aiProfileFacts.candidates.length > 0;

  // Regex-based memory extraction (fallback when AI unavailable or returns empty)
  const memoryRoles = hasAIResults ? { candidates: [], evidence: [] } : extractRolesFromMemory(memoryProfileEntries);
  const memoryResponsibilities = hasAIResults ? { candidates: [], evidence: [] } : extractResponsibilitiesFromMemory(memoryProfileEntries);
  const memoryFocusAreas = hasAIResults ? { candidates: [], evidence: [] } : extractFocusAreasFromMemory(memoryProfileEntries);

  // Decision-inferred (always runs — complementary to AI)
  const inferredRoles = inferRoleFromDecisions(layer3Decisions);
  const inferredResponsibilities = inferResponsibilitiesFromDecisions(layer3Decisions, memoryDecisions);
  const decisionFocusAreas = extractFocusAreasFromDecisions(layer3Decisions, memoryDecisions);
  const preferenceFocusAreas = extractFocusAreasFromPreferences(layer3Preferences);

  return {
    candidates: [
      ...aiProfileFacts.candidates,
      ...memoryRoles.candidates,
      ...inferredRoles.candidates,
      ...memoryResponsibilities.candidates,
      ...inferredResponsibilities.candidates,
      ...decisionFocusAreas.candidates,
      ...memoryFocusAreas.candidates,
      ...preferenceFocusAreas.candidates,
    ],
    evidence: [
      ...aiProfileFacts.evidence,
      ...memoryRoles.evidence,
      ...inferredRoles.evidence,
      ...memoryResponsibilities.evidence,
      ...inferredResponsibilities.evidence,
      ...decisionFocusAreas.evidence,
      ...memoryFocusAreas.evidence,
      ...preferenceFocusAreas.evidence,
    ],
  };
}
