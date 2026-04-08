import { computeContentHash } from '../../memory/types.js';
import type { TodoWithContext } from '../../utils/renderer.js';
import {
  computeCanonicalKey,
  computeFingerprint,
  type EvidenceRecord,
  type OpenThreadPayload,
  type SignalCandidate,
} from '../types.js';

function clampTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 79).trim()}…`;
}

function mapStatus(status: string): OpenThreadPayload['status'] | null {
  if (status === 'in_progress') return 'in_progress';
  if (status === 'pending') return 'open';
  return null;
}

export function extractOpenThreadCandidates(
  todos: TodoWithContext[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const todo of todos) {
    const title = clampTitle(todo.content);
    if (title.length === 0) continue;

    const mappedStatus = mapStatus(todo.status);
    if (mappedStatus == null) continue;

    const stableKey = `open-thread:${todo.projectName}:${todo.sessionId ?? 'no-session'}:${todo.content}`;
    const evidenceId = computeContentHash(stableKey);

    const now = Date.now();
    const capturedAt = todo.timeCreated ?? now;
    const todayStr = new Date(now).toISOString().slice(0, 10);

    const evidenceRecord: EvidenceRecord = {
      id: evidenceId,
      sourceKind: 'session_todo',
      sourceLabel: todo.sourceLabel,
      projectName: todo.projectName,
      sessionId: todo.sessionId,
      todoId: evidenceId,
      content: title,
      contentHash: computeContentHash(title),
      capturedAt,
      observedAt: todayStr,
      trustScore: 2,
      recencyScore: 1,
      extractionHints: ['open_thread'],
    };

    const payload: OpenThreadPayload = {
      threadType: 'todo',
      title,
      status: mappedStatus,
      nextAction: undefined,
    };

    const candidate: SignalCandidate = {
      id: computeContentHash(`open-thread-candidate:${todo.projectName}:${todo.content}`),
      kind: 'open_thread',
      evidenceIds: [evidenceId],
      primaryEvidenceId: evidenceId,
      projectName: todo.projectName,
      confidence: 0.8,
      trustScore: 2,
      sourceLabels: [todo.sourceLabel],
      observedAt: evidenceRecord.observedAt,
      extractor: 'canonical-layer1-open-thread',
      rawText: title,
      payload,
    };

    candidate.fingerprint = computeFingerprint(candidate.kind, candidate.payload);
    candidate.canonicalKeyHint = computeCanonicalKey(candidate);

    evidence.push(evidenceRecord);
    candidates.push(candidate);
  }

  return { candidates, evidence };
}
