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
// Constants
// ============================================================

const MAX_CLAIM_CHARS = 80;
const MAX_RATIONALE_CHARS = 120;

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

// ============================================================
// Helpers
// ============================================================

function clamp(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trim()}…`;
}

function isRawChatText(text: string): boolean {
  if (text.length > RAW_TEXT_LENGTH_THRESHOLD) return true;
  if (MARKDOWN_NOISE_PATTERN.test(text)) return true;
  return false;
}

function buildEvidenceId(prefix: string, stableKey: string): string {
  return computeContentHash(`${prefix}:${stableKey}`);
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
  const techKeywords = /架构|重构|迁移|部署|数据库|schema|API|性能|算法|模型|SDK|pipeline|encoding|分轨|转录/i;
  const quantKeywords = /量化|套利|资金费率|funding|对冲|hedge|交易|trading|持仓|仓位|做市|Binance|DEX|swap/i;

  let productCount = 0;
  let techCount = 0;
  let quantCount = 0;

  for (const d of decisions) {
    const combined = `${d.what} ${d.why} ${d.trigger}`;
    if (productKeywords.test(combined)) productCount++;
    if (techKeywords.test(combined)) techCount++;
    if (quantKeywords.test(combined)) quantCount++;
  }

  const total = decisions.length;
  const roleParts: string[] = [];

  if (productCount / total >= 0.2) roleParts.push('产品经理');
  if (techCount / total >= 0.2) roleParts.push('开发者');
  if (quantCount / total >= 0.1) roleParts.push('量化开发者');

  if (roleParts.length === 0) return { candidates, evidence };

  const roleClaim = roleParts.join('兼');
  const rationale = `基于${total}条决策记录推断：产品${productCount}条、技术${techCount}条、量化${quantCount}条`;

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
  const projectDecisions = new Map<string, { count: number; themes: Set<string> }>();

  for (const d of layer3Decisions) {
    const project = d.projectName?.trim();
    if (!project) continue;
    if (!projectDecisions.has(project)) {
      projectDecisions.set(project, { count: 0, themes: new Set() });
    }
    const entry = projectDecisions.get(project)!;
    entry.count++;
    // Extract high-level theme from 'what'
    const what = d.what.trim();
    if (what.length > 0 && what.length <= 80) {
      entry.themes.add(what);
    }
  }

  for (const md of memoryDecisions) {
    const project = md.projectName?.trim();
    if (!project) continue;
    if (!projectDecisions.has(project)) {
      projectDecisions.set(project, { count: 0, themes: new Set() });
    }
    const entry = projectDecisions.get(project)!;
    entry.count++;
    const what = md.what.trim();
    if (what.length > 0 && what.length <= 80) {
      entry.themes.add(what);
    }
  }

  // Only create responsibility facts for projects with enough decisions (stability signal)
  for (const [project, data] of projectDecisions) {
    if (data.count < 3) continue;

    const claim = `负责${project}项目方案推动和落地`;
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

  const domainPatterns: Array<{ label: string; pattern: RegExp }> = [
    { label: 'DeFi 套利', pattern: /DeFi|套利|arbitrage|对冲/i },
    { label: 'RWA 代币化', pattern: /RWA|代币化|tokeniz/i },
    { label: 'AI Agent', pattern: /AI\s*Agent|智能代理/i },
    { label: '量化交易', pattern: /量化交易|量化|quant|trading\s*system/i },
    { label: '资金费率', pattern: /资金费率|funding\s*rate|funding\s*arb/i },
    { label: '知识库', pattern: /知识库|knowledge\s*base|session.?memory/i },
    { label: '企业内部工具', pattern: /内部工具|企业.*工具|internal\s*tool/i },
    { label: '会议记录系统', pattern: /会议记录|会议.*转录|meeting.*record|voice.*secretary/i },
    { label: '语音转录', pattern: /语音转录|whisper|transcri/i },
    { label: '加密货币', pattern: /加密货币|crypto|区块链|blockchain|链上|on.?chain|web3/i },
    { label: 'Meme 交易', pattern: /meme|pump\.fun|four\.meme/i },
  ];

  for (const text of allTexts) {
    for (const dp of domainPatterns) {
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

    const trustScore: 1 | 2 | 3 | 4 | 5 = entry.sourceLabel === 'rule' ? 5 : 4;

    const evidenceId = buildEvidenceId('memory-profile-focus', `${entry.stableId}:${observation}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'memory_file',
      sourceLabel: entry.sourceLabel,
      filePath: entry.sourcePath,
      content: observation,
      contentHash: computeContentHash(`focus:${entry.stableId}:${observation}`),
      capturedAt: Date.now(),
      trustScore,
      recencyScore: 1,
      extractionHints: ['profile-fact', 'focus_area'],
      metadata: { stableId: entry.stableId },
    };

    const payload: ProfileFactPayload = {
      dimension: 'focus_area',
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

    const evidenceId = buildEvidenceId('layer3-pref-focus', `${pref.category}:${observation}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'session_message',
      sourceLabel: 'layer3-ai',
      content: observation,
      contentHash: computeContentHash(`focus-pref:${pref.category}:${observation}`),
      capturedAt: Date.now(),
      trustScore: 3,
      recencyScore: 0.7,
      extractionHints: ['profile-fact', 'focus_area'],
      metadata: { originalCategory: pref.category },
    };

    const payload: ProfileFactPayload = {
      dimension: 'focus_area',
      claim: clamp(observation, MAX_CLAIM_CHARS),
      scope: 'global',
      rationale: pref.evidence && pref.evidence !== observation
        ? clamp(pref.evidence, MAX_RATIONALE_CHARS)
        : undefined,
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer3-bridge-profile-fact', 0.65));
  }

  return { candidates, evidence };
}

// ============================================================
// Public API
// ============================================================

export function extractProfileFactCandidates(
  layer3Preferences: Preference[],
  layer3Decisions: Decision[],
  memoryProfileEntries: MemoryProfileEntry[],
  memoryDecisions: MemoryDecision[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  // Role dimension
  const memoryRoles = extractRolesFromMemory(memoryProfileEntries);
  const inferredRoles = inferRoleFromDecisions(layer3Decisions);

  // Responsibility dimension
  const memoryResponsibilities = extractResponsibilitiesFromMemory(memoryProfileEntries);
  const inferredResponsibilities = inferResponsibilitiesFromDecisions(layer3Decisions, memoryDecisions);

  // Focus area dimension
  const decisionFocusAreas = extractFocusAreasFromDecisions(layer3Decisions, memoryDecisions);
  const memoryFocusAreas = extractFocusAreasFromMemory(memoryProfileEntries);
  const preferenceFocusAreas = extractFocusAreasFromPreferences(layer3Preferences);

  return {
    candidates: [
      ...memoryRoles.candidates,
      ...inferredRoles.candidates,
      ...memoryResponsibilities.candidates,
      ...inferredResponsibilities.candidates,
      ...decisionFocusAreas.candidates,
      ...memoryFocusAreas.candidates,
      ...preferenceFocusAreas.candidates,
    ],
    evidence: [
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
