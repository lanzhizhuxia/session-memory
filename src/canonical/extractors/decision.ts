import type { Decision } from '../../extractors/layer3.js';
import { computeContentHash, type MemoryDecision } from '../../memory/types.js';
import {
  computeCanonicalKey,
  computeFingerprint,
  type DecisionPayload,
  type EvidenceRecord,
  type SignalCandidate,
} from '../types.js';

// ============================================================
// Constants & filtering
// ============================================================

const MAX_DECISION_CHARS = 320;
const MAX_RATIONALE_CHARS = 280;
const MAX_TOPIC_CHARS = 120;

/** Status words that are not real decisions — skip these entries. */
const STATUS_WORD_PATTERN = /^(问题|已修复|TODO|Review|PRD已完成|Bug|修复|完成|待处理|待办)$/i;
const META_COMMENTARY_PATTERNS = [
  /无法确认.*决策/,
  /未发现.*决策/,
  /未达成.*决策/,
  /没有.*明确.*决策/,
  /insufficient\s+context/i,
  /no\s+explicit\s+decision/i,
  /未提取到.*决策/,
  /无法从.*中提取/,
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

function buildEvidenceId(prefix: string, stableKey: string): string {
  return computeContentHash(`${prefix}:${stableKey}`);
}

export function isMetaCommentary(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return META_COMMENTARY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isSkippableDecision(what: string): boolean {
  const trimmed = what.trim();
  if (trimmed.length === 0) return true;
  if (STATUS_WORD_PATTERN.test(trimmed)) return true;
  if (isMetaCommentary(trimmed)) return true;
  return false;
}

function deriveTopic(what: string): string {
  return clamp(what, MAX_TOPIC_CHARS);
}

function deriveScope(projectName: string | undefined): 'project' | 'cross_project' {
  if (projectName != null && projectName.trim().length > 0) return 'project';
  return 'cross_project';
}

function buildCandidateFromPayload(
  payload: DecisionPayload,
  evidence: EvidenceRecord,
  extractor: string,
  confidence: number,
): SignalCandidate {
  const candidate: SignalCandidate = {
    id: computeContentHash(`${evidence.id}:decision:${payload.topic}:${payload.decision}`),
    kind: 'decision',
    evidenceIds: [evidence.id],
    primaryEvidenceId: evidence.id,
    projectId: evidence.projectId,
    projectName: evidence.projectName,
    canonicalProjectPath: evidence.canonicalProjectPath,
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
// Layer 3 Decision[] → decision candidates
// ============================================================

function extractFromLayer3Decisions(
  decisions: Decision[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const d of decisions) {
    if (isSkippableDecision(d.what)) continue;
    if (isMetaCommentary(d.why ?? '')) continue;

    const topic = deriveTopic(d.what);
    const decision = clamp(d.what, MAX_DECISION_CHARS);
    const rationale = clamp(d.why?.trim() ?? '', MAX_RATIONALE_CHARS);
    const scope = deriveScope(d.projectName);

    const evidenceId = buildEvidenceId('layer3-decision', `${d.sessionId}:${d.what}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'session_message',
      sourceLabel: d.sourceLabel ?? 'layer3-ai',
      projectName: d.projectName,
      sessionId: d.sessionId,
      content: `${d.what}${d.why ? ` — ${d.why}` : ''}`,
      contentHash: computeContentHash(`${d.sessionId}:${d.what}:${d.why ?? ''}`),
      capturedAt: Date.now(),
      observedAt: d.date,
      trustScore: 3,
      recencyScore: 0.7,
      extractionHints: ['decision'],
      metadata: {
        sessionTitle: d.sessionTitle,
        trigger: d.trigger ?? '',
      },
    };

    const payload: DecisionPayload = {
      topic,
      decision,
      rationale,
      alternatives: d.alternatives ?? [],
      trigger: d.trigger?.trim() || undefined,
      scope,
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer3-bridge-decision', 0.6));
  }

  return { candidates, evidence };
}

// ============================================================
// Memory MemoryDecision[] → decision candidates
// ============================================================

function extractFromMemoryDecisions(
  memoryDecisions: MemoryDecision[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const md of memoryDecisions) {
    if (isSkippableDecision(md.what)) continue;
    if (isMetaCommentary(md.why ?? '')) continue;

    const topic = deriveTopic(md.what);
    const decision = clamp(md.what, MAX_DECISION_CHARS);
    const rationale = clamp(md.why?.trim() ?? '', MAX_RATIONALE_CHARS);
    const scope = deriveScope(md.projectName);

    // Memory-derived entries get higher trust (4-5)
    const trustScore: 4 | 5 = md.sourceLabel === 'rule' ? 5 : 4;

    const evidenceId = buildEvidenceId('memory-decision', `${md.stableId}:${md.what}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'memory_file',
      sourceLabel: md.sourceLabel,
      filePath: md.sourcePath,
      projectName: md.projectName,
      content: `${md.what}${md.why ? ` — ${md.why}` : ''}`,
      contentHash: computeContentHash(`${md.stableId}:${md.what}:${md.why ?? ''}`),
      capturedAt: Date.now(),
      observedAt: md.date,
      trustScore,
      recencyScore: 1,
      extractionHints: ['decision'],
      metadata: {
        stableId: md.stableId,
      },
    };

    const payload: DecisionPayload = {
      topic,
      decision,
      rationale,
      alternatives: md.alternatives ?? [],
      trigger: md.trigger?.trim() || undefined,
      scope,
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer0-memory-decision', 0.8));
  }

  return { candidates, evidence };
}

// ============================================================
// Public API
// ============================================================

export function extractDecisionCandidates(
  layer3Decisions: Decision[],
  memoryDecisions: MemoryDecision[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const layer3Result = extractFromLayer3Decisions(layer3Decisions);
  const memoryResult = extractFromMemoryDecisions(memoryDecisions);

  return {
    candidates: [...layer3Result.candidates, ...memoryResult.candidates],
    evidence: [...layer3Result.evidence, ...memoryResult.evidence],
  };
}
