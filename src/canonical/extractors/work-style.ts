import type { Preference } from '../../extractors/layer3.js';
import { computeContentHash, type MemoryProfileEntry } from '../../memory/types.js';
import {
  computeCanonicalKey,
  computeFingerprint,
  type EvidenceRecord,
  type SignalCandidate,
  type WorkStylePayload,
} from '../types.js';

// ============================================================
// Constants & filtering
// ============================================================

const MAX_CLAIM_CHARS = 120;
const MAX_RATIONALE_CHARS = 120;

/** Entries longer than this are likely raw chat text, not distilled observations. */
const RAW_TEXT_LENGTH_THRESHOLD = 200;

/** Markdown formatting signals that indicate raw chat paste. */
const MARKDOWN_NOISE_PATTERN = /```|^\s*[-*+]\s+.+\n\s*[-*+]\s+|^\|.*\|$/m;

/** Dimension mapping: normalize Layer 3 category names to canonical dimensions. */
const DIMENSION_MAP: Record<string, string> = {
  '交互方式': '交互风格',
  '交互风格': '交互风格',
  'interaction style': '交互风格',
  '与 ai 的交互方式': '交互风格',
  '对 ai 建议的反应': 'AI 协作模式',
  'ai 协作模式': 'AI 协作模式',
  '语言偏好': '语言偏好',
  '沟通风格': '语言偏好',
  '技术审美': '技术审美',
  '工作节奏': '工作节奏',
  '质量标准': '质量标准',
  '需求表达': '需求表达',
  '领域特征': '领域特征',
};

/** Categories that map to "其他" and need extra behavioral check. */
const MISC_CATEGORY_PATTERN = /^其他$|^other$/i;

/** AI/system behavior markers — claims about AI, not user. */
const AI_BEHAVIOR_PATTERN = /AI\s*助手|Claude|系统提示|model\s+behavior|system\s+prompt/i;

/** Project-specific operational patterns — instructions, not behavioral patterns. */
const OPERATIONAL_INSTRUCTION_PATTERN = /^(task:|expected outcome:|must do:|must not do:|context:)/i;

// ============================================================
// Helpers
// ============================================================

function clamp(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trim()}…`;
}

function normalizeDimension(category: string): string {
  const lower = category.toLowerCase().trim();
  return DIMENSION_MAP[lower] ?? category.trim();
}

function isRawChatText(text: string): boolean {
  if (text.length > RAW_TEXT_LENGTH_THRESHOLD) return true;
  if (MARKDOWN_NOISE_PATTERN.test(text)) return true;
  return false;
}

function isOperationalInstruction(text: string): boolean {
  return OPERATIONAL_INSTRUCTION_PATTERN.test(text.trim());
}

function isMiscWithoutBehavior(category: string, observation: string): boolean {
  if (!MISC_CATEGORY_PATTERN.test(category.trim())) return false;
  // For "其他" category, keep only entries that mention user behavior verbs
  const behaviorVerbs = /偏好|习惯|倾向|模式|风格|方式|喜欢|频繁|总是|prefer|tend|habit|pattern|style/i;
  return !behaviorVerbs.test(observation);
}

function buildEvidenceId(prefix: string, stableKey: string): string {
  return computeContentHash(`${prefix}:${stableKey}`);
}

function buildCandidateFromPayload(
  payload: WorkStylePayload,
  evidence: EvidenceRecord,
  extractor: string,
  confidence: number,
): SignalCandidate {
  const candidate: SignalCandidate = {
    id: computeContentHash(`${evidence.id}:ws:${payload.dimension}:${payload.claim}`),
    kind: 'work_style',
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
// Layer 3 Preference[] → work_style candidates
// ============================================================

function extractFromLayer3Preferences(
  preferences: Preference[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const pref of preferences) {
    const observation = pref.observation?.trim() ?? '';
    const category = pref.category?.trim() ?? '';
    const evidenceText = pref.evidence?.trim() ?? '';

    // Skip empty
    if (observation.length === 0 || category.length === 0) continue;

    // Skip raw chat text
    if (isRawChatText(observation)) continue;
    if (isRawChatText(evidenceText)) continue;

    // Skip operational instructions
    if (isOperationalInstruction(observation)) continue;

    // Skip "其他" without behavioral signal
    if (isMiscWithoutBehavior(category, observation)) continue;

    // Skip claims about AI behavior, not user behavior
    if (AI_BEHAVIOR_PATTERN.test(observation)) continue;

    const dimension = normalizeDimension(category);
    const claim = clamp(observation, MAX_CLAIM_CHARS);
    const rationale = evidenceText.length > 0 && evidenceText !== observation
      ? clamp(evidenceText, MAX_RATIONALE_CHARS)
      : undefined;

    const evidenceId = buildEvidenceId('layer3-pref', `${category}:${observation}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'session_message',
      sourceLabel: 'layer3-ai',
      content: `${observation}${evidenceText.length > 0 ? ` — ${evidenceText}` : ''}`,
      contentHash: computeContentHash(`${category}:${observation}:${evidenceText}`),
      capturedAt: Date.now(),
      trustScore: 3,
      recencyScore: 0.7,
      extractionHints: ['work-style'],
      metadata: {
        originalCategory: category,
      },
    };

    const payload: WorkStylePayload = {
      dimension,
      claim,
      rationale,
      frequency: 'repeated',
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer3-bridge-work-style', 0.7));
  }

  return { candidates, evidence };
}

// ============================================================
// Layer 0 MemoryProfileEntry[] → work_style candidates
// ============================================================

function extractFromMemoryProfile(
  entries: MemoryProfileEntry[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const entry of entries) {
    const observation = entry.observation?.trim() ?? '';
    const category = entry.category?.trim() ?? '';
    const entryEvidence = entry.evidence?.trim() ?? '';

    // Skip empty
    if (observation.length === 0 || category.length === 0) continue;

    // Skip raw chat text
    if (isRawChatText(observation)) continue;

    // Skip operational instructions
    if (isOperationalInstruction(observation)) continue;

    // Skip "其他" without behavioral signal
    if (isMiscWithoutBehavior(category, observation)) continue;

    // Skip claims about AI behavior
    if (AI_BEHAVIOR_PATTERN.test(observation)) continue;

    const dimension = normalizeDimension(category);
    const claim = clamp(observation, MAX_CLAIM_CHARS);
    const rationale = entryEvidence.length > 0 && entryEvidence !== observation
      ? clamp(entryEvidence, MAX_RATIONALE_CHARS)
      : undefined;

    // Memory-derived entries get higher trust (4-5)
    const trustScore: 1 | 2 | 3 | 4 | 5 = entry.sourceLabel === 'rule' ? 5 : 4;

    const evidenceId = buildEvidenceId('memory-profile', `${entry.stableId}:${category}:${observation}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'memory_file',
      sourceLabel: entry.sourceLabel,
      filePath: entry.sourcePath,
      content: `${observation}${entryEvidence.length > 0 ? ` — ${entryEvidence}` : ''}`,
      contentHash: computeContentHash(`${entry.stableId}:${category}:${observation}`),
      capturedAt: Date.now(),
      trustScore,
      recencyScore: 1,
      extractionHints: ['work-style'],
      metadata: {
        stableId: entry.stableId,
        originalCategory: category,
      },
    };

    const payload: WorkStylePayload = {
      dimension,
      claim,
      rationale,
      frequency: 'habitual',
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer0-memory-work-style', 0.8));
  }

  return { candidates, evidence };
}

// ============================================================
// Public API
// ============================================================

export function extractWorkStyleCandidates(
  layer3Preferences: Preference[],
  memoryProfileEntries: MemoryProfileEntry[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const layer3Result = extractFromLayer3Preferences(layer3Preferences);
  const memoryResult = extractFromMemoryProfile(memoryProfileEntries);

  return {
    candidates: [...layer3Result.candidates, ...memoryResult.candidates],
    evidence: [...layer3Result.evidence, ...memoryResult.evidence],
  };
}
