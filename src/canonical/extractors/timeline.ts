import { computeContentHash } from '../../memory/types.js';
import type { TimelineData } from '../../utils/renderer.js';
import {
  computeCanonicalKey,
  computeFingerprint,
  type EvidenceRecord,
  type SignalCandidate,
  type TimelineEventPayload,
} from '../types.js';

const DELIVERY_PATTERN = /deploy|release|上线|发布|交付/i;
const INCIDENT_PATTERN = /fix|bug|修复|hotfix|incident|故障/i;
const REFACTOR_PATTERN = /refactor|重构/i;
const MILESTONE_PATTERN = /review|通过|milestone|完成|merge/i;

function inferEventType(title: string): TimelineEventPayload['eventType'] {
  if (DELIVERY_PATTERN.test(title)) return 'delivery';
  if (INCIDENT_PATTERN.test(title)) return 'incident';
  if (REFACTOR_PATTERN.test(title)) return 'refactor';
  if (MILESTONE_PATTERN.test(title)) return 'milestone';
  return 'milestone';
}

function clampTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 79).trim()}…`;
}

export function extractTimelineCandidates(
  timelineData: TimelineData,
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const project of timelineData.projects) {
    for (const day of project.days) {
      for (const session of day.sessions) {
        const title = clampTitle(session.title);
        if (title.length === 0 || title === '(untitled)') continue;

        const evidenceId = computeContentHash(`timeline:${project.name}:${day.date}:${session.id}`);
        const evidenceRecord: EvidenceRecord = {
          id: evidenceId,
          sourceKind: 'session_message',
          sourceLabel: session.sourceLabel,
          projectName: project.name,
          sessionId: session.id,
          content: title,
          contentHash: computeContentHash(title),
          capturedAt: Date.now(),
          observedAt: day.date,
          trustScore: 2,
          recencyScore: 1,
          extractionHints: ['timeline_event'],
        };

        const payload: TimelineEventPayload = {
          eventType: inferEventType(title),
          title,
          summary: title,
          date: day.date,
        };

        const candidate: SignalCandidate = {
          id: computeContentHash(`timeline-candidate:${project.name}:${day.date}:${session.id}`),
          kind: 'timeline_event',
          evidenceIds: [evidenceId],
          primaryEvidenceId: evidenceId,
          projectName: project.name,
          confidence: 0.9,
          trustScore: 2,
          sourceLabels: [session.sourceLabel],
          observedAt: day.date,
          extractor: 'canonical-layer1-timeline',
          rawText: title,
          payload,
        };

        candidate.fingerprint = computeFingerprint(candidate.kind, candidate.payload);
        candidate.canonicalKeyHint = computeCanonicalKey(candidate);

        evidence.push(evidenceRecord);
        candidates.push(candidate);
      }
    }
  }

  return { candidates, evidence };
}
