import type { PainPoint } from '../../extractors/layer3.js';
import { computeContentHash, type MemoryPainPoint } from '../../memory/types.js';
import {
  computeCanonicalKey,
  computeFingerprint,
  type EvidenceRecord,
  type PainPointPayload,
  type SignalCandidate,
} from '../types.js';

// ============================================================
// Constants
// ============================================================

const MAX_PROBLEM_CHARS = 200;
const MAX_DIAGNOSIS_CHARS = 150;
const MAX_WORKAROUND_CHARS = 150;
const MIN_PROBLEM_CHARS = 10;

// ============================================================
// Helpers
// ============================================================

function clamp(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trim()}…`;
}

function buildEvidenceId(prefix: string, stableKey: string): string {
  return computeContentHash(`${prefix}:${stableKey}`);
}

function isSkippablePainPoint(problem: string): boolean {
  const trimmed = problem.trim();
  return trimmed.length < MIN_PROBLEM_CHARS;
}

function deriveRecurrence(likelyRecurring: boolean | undefined): 'low' | 'medium' | 'high' {
  if (likelyRecurring === true) return 'high';
  if (likelyRecurring === false) return 'low';
  return 'medium';
}

function buildCandidateFromPayload(
  payload: PainPointPayload,
  evidence: EvidenceRecord,
  extractor: string,
  confidence: number,
): SignalCandidate {
  const candidate: SignalCandidate = {
    id: computeContentHash(`${evidence.id}:pain_point:${payload.problem}`),
    kind: 'pain_point',
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
// Layer 3 PainPoint[] → pain_point candidates
// ============================================================

function extractFromLayer3PainPoints(
  painPoints: PainPoint[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const pp of painPoints) {
    if (isSkippablePainPoint(pp.problem)) continue;

    const problem = clamp(pp.problem, MAX_PROBLEM_CHARS);
    const diagnosis = pp.diagnosis?.trim() ? clamp(pp.diagnosis, MAX_DIAGNOSIS_CHARS) : undefined;
    const workaround = pp.solution?.trim() ? clamp(pp.solution, MAX_WORKAROUND_CHARS) : undefined;
    const recurrence = deriveRecurrence(pp.likely_recurring);

    const evidenceId = buildEvidenceId('layer3-painpoint', `${pp.sessionId}:${pp.problem}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'session_message',
      sourceLabel: pp.sourceLabel ?? 'layer3-ai',
      projectName: pp.projectName,
      sessionId: pp.sessionId,
      content: `${pp.problem}${pp.diagnosis ? ` — ${pp.diagnosis}` : ''}`,
      contentHash: computeContentHash(`${pp.sessionId}:${pp.problem}:${pp.diagnosis ?? ''}`),
      capturedAt: Date.now(),
      trustScore: 3,
      recencyScore: 0.7,
      extractionHints: ['pain-point'],
      metadata: {
        sessionTitle: pp.sessionTitle,
      },
    };

    const payload: PainPointPayload = {
      problem,
      diagnosis,
      workaround,
      recurrence,
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer3-bridge-pain-point', 0.6));
  }

  return { candidates, evidence };
}

// ============================================================
// Memory MemoryPainPoint[] → pain_point candidates
// ============================================================

function extractFromMemoryPainPoints(
  memoryPainPoints: MemoryPainPoint[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const mp of memoryPainPoints) {
    if (isSkippablePainPoint(mp.problem)) continue;

    const problem = clamp(mp.problem, MAX_PROBLEM_CHARS);
    const diagnosis = mp.diagnosis?.trim() ? clamp(mp.diagnosis, MAX_DIAGNOSIS_CHARS) : undefined;
    const workaround = mp.solution?.trim() ? clamp(mp.solution, MAX_WORKAROUND_CHARS) : undefined;
    const recurrence = deriveRecurrence(mp.likelyRecurring);

    const trustScore: 4 | 5 = mp.sourceLabel === 'rule' ? 5 : 4;

    const evidenceId = buildEvidenceId('memory-painpoint', `${mp.stableId}:${mp.problem}`);
    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'memory_file',
      sourceLabel: mp.sourceLabel,
      filePath: mp.sourcePath,
      projectName: mp.projectName,
      content: `${mp.problem}${mp.diagnosis ? ` — ${mp.diagnosis}` : ''}`,
      contentHash: computeContentHash(`${mp.stableId}:${mp.problem}:${mp.diagnosis ?? ''}`),
      capturedAt: Date.now(),
      trustScore,
      recencyScore: 1,
      extractionHints: ['pain-point'],
      metadata: {
        stableId: mp.stableId,
      },
    };

    const payload: PainPointPayload = {
      problem,
      diagnosis,
      workaround,
      recurrence,
    };

    evidence.push(evidenceRecord);
    candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer0-memory-pain-point', 0.8));
  }

  return { candidates, evidence };
}

// ============================================================
// Public API
// ============================================================

export function extractPainPointCandidates(
  layer3PainPoints: PainPoint[],
  memoryPainPoints: MemoryPainPoint[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const layer3Result = extractFromLayer3PainPoints(layer3PainPoints);
  const memoryResult = extractFromMemoryPainPoints(memoryPainPoints);

  return {
    candidates: [...layer3Result.candidates, ...memoryResult.candidates],
    evidence: [...layer3Result.evidence, ...memoryResult.evidence],
  };
}
