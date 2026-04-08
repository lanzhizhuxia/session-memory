import { computeCanonicalKey, computeFingerprint, type CanonicalSignal, type SignalCandidate, type SignalKind } from './types.js';

interface MergeAccumulator {
  members: SignalCandidate[];
  existing?: CanonicalSignal;
}

function toTimestamp(observedAt?: string, fallback?: number): number {
  if (observedAt == null) {
    return fallback ?? Date.now();
  }

  const parsed = Date.parse(observedAt);
  return Number.isNaN(parsed) ? (fallback ?? Date.now()) : parsed;
}

function summarizeCandidatePayload(candidate: SignalCandidate): string {
  switch (candidate.kind) {
    case 'tech_preference':
      return `${candidate.payload.technology} (${candidate.payload.stance}): ${candidate.payload.rationale}`;
    case 'decision':
      return `${candidate.payload.topic}: ${candidate.payload.decision}`;
    case 'pain_point':
      return candidate.payload.problem;
    case 'work_style':
      return candidate.payload.claim;
    case 'profile_fact':
      return candidate.payload.claim;
    case 'timeline_event':
      return `${candidate.payload.date} ${candidate.payload.title}`;
    case 'open_thread':
      return candidate.payload.title;
  }
}

function summarizeSignal(signal: CanonicalSignal): string {
  switch (signal.kind) {
    case 'tech_preference':
      return `${signal.payload.technology} (${signal.payload.stance}): ${signal.payload.rationale}`;
    case 'decision':
      return `${signal.payload.topic}: ${signal.payload.decision}`;
    case 'pain_point':
      return signal.payload.problem;
    case 'work_style':
      return signal.payload.claim;
    case 'profile_fact':
      return signal.payload.claim;
    case 'timeline_event':
      return `${signal.payload.date} ${signal.payload.title}`;
    case 'open_thread':
      return signal.payload.title;
  }
}

function candidateRank(candidate: SignalCandidate | CanonicalSignal): [number, number, number, string] {
  const trustScore = candidate.trustScore;
  const confidence = candidate.confidence;
  const recency = 'lastSeenAt' in candidate
    ? candidate.lastSeenAt
    : toTimestamp(candidate.observedAt);
  return [trustScore, confidence, recency, candidate.id];
}

function pickBase<T extends SignalCandidate | CanonicalSignal>(candidates: T[]): T {
  return [...candidates].sort((left, right) => {
    const [leftTrust, leftConfidence, leftRecency, leftId] = candidateRank(left);
    const [rightTrust, rightConfidence, rightRecency, rightId] = candidateRank(right);

    return (
      rightTrust - leftTrust
      || rightConfidence - leftConfidence
      || rightRecency - leftRecency
      || leftId.localeCompare(rightId)
    );
  })[0];
}


function signalFromCandidate(candidate: SignalCandidate): CanonicalSignal {
  const fingerprint = candidate.fingerprint ?? computeFingerprint(candidate.kind, candidate.payload);
  const canonicalKey = candidate.canonicalKeyHint ?? computeCanonicalKey(candidate);
  const seenAt = toTimestamp(candidate.observedAt);

  return {
    ...candidate,
    canonicalKey,
    fingerprintSet: [fingerprint],
    status: 'active',
    projectIds: candidate.projectId != null ? [candidate.projectId] : [],
    projectNames: candidate.projectName != null ? [candidate.projectName] : [],
    evidenceIds: [...candidate.evidenceIds],
    sourceLabels: [...(candidate.sourceLabels ?? [])],
    supportCount: candidate.evidenceIds.length,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    summary: summarizeCandidatePayload(candidate),
    mergeNotes: [],
  };
}

function mergeCandidateIntoSignal(signal: CanonicalSignal, candidate: SignalCandidate): CanonicalSignal {
  const fingerprint = candidate.fingerprint ?? computeFingerprint(candidate.kind, candidate.payload);
  const evidenceIds = Array.from(new Set([...signal.evidenceIds, ...candidate.evidenceIds]));
  const projectIds = Array.from(new Set([...signal.projectIds, ...(candidate.projectId != null ? [candidate.projectId] : [])]));
  const projectNames = Array.from(new Set([...signal.projectNames, ...(candidate.projectName != null ? [candidate.projectName] : [])]));
  const sourceLabels = Array.from(new Set([...signal.sourceLabels, ...(candidate.sourceLabels ?? [])]));
  const firstSeenAt = Math.min(signal.firstSeenAt, toTimestamp(candidate.observedAt, signal.firstSeenAt));
  const lastSeenAt = Math.max(signal.lastSeenAt, toTimestamp(candidate.observedAt, signal.lastSeenAt));
  const preferred = pickBase<SignalCandidate | CanonicalSignal>([signal, candidate]);
  const payload = preferred.payload as CanonicalSignal['payload'];

  return {
    ...signal,
    payload,
    fingerprintSet: Array.from(new Set([...signal.fingerprintSet, fingerprint])),
    evidenceIds,
    projectIds,
    projectNames,
    sourceLabels,
    trustScore: Math.max(signal.trustScore, candidate.trustScore) as 1 | 2 | 3 | 4 | 5,
    confidence: Math.max(signal.confidence, candidate.confidence),
    supportCount: evidenceIds.length,
    firstSeenAt,
    lastSeenAt,
    summary: summarizeSignal({ ...signal, payload } as CanonicalSignal),
    mergeNotes: Array.from(new Set([...(signal.mergeNotes ?? []), `merged:${candidate.id}`])),
  } as CanonicalSignal;
}

function mergeSignals(baseSignal: CanonicalSignal, incoming: CanonicalSignal): CanonicalSignal {
  const evidenceIds = Array.from(new Set([...baseSignal.evidenceIds, ...incoming.evidenceIds]));
  const sourceLabels = Array.from(new Set([...baseSignal.sourceLabels, ...incoming.sourceLabels]));
  const preferred = pickBase<CanonicalSignal>([baseSignal, incoming]);
  const payload = preferred.payload as CanonicalSignal['payload'];

  return {
    ...baseSignal,
    payload,
    fingerprintSet: Array.from(new Set([...baseSignal.fingerprintSet, ...incoming.fingerprintSet])),
    evidenceIds,
    projectIds: Array.from(new Set([...baseSignal.projectIds, ...incoming.projectIds])),
    projectNames: Array.from(new Set([...baseSignal.projectNames, ...incoming.projectNames])),
    sourceLabels,
    trustScore: Math.max(baseSignal.trustScore, incoming.trustScore) as 1 | 2 | 3 | 4 | 5,
    confidence: Math.max(baseSignal.confidence, incoming.confidence),
    supportCount: evidenceIds.length,
    firstSeenAt: Math.min(baseSignal.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(baseSignal.lastSeenAt, incoming.lastSeenAt),
    lastPublishedAt: Math.max(baseSignal.lastPublishedAt ?? 0, incoming.lastPublishedAt ?? 0) || undefined,
    summary: summarizeSignal({ ...baseSignal, payload } as CanonicalSignal),
    mergeNotes: Array.from(new Set([...(baseSignal.mergeNotes ?? []), ...(incoming.mergeNotes ?? []), `merged-signal:${incoming.id}`])),
  } as CanonicalSignal;
}

export function mergeIntoStore(
  candidates: SignalCandidate[],
  existingSignals: CanonicalSignal[],
  kind: SignalKind,
): { signals: CanonicalSignal[]; quarantined: SignalCandidate[] } {
  const relevantSignals = existingSignals.filter((signal) => signal.kind === kind);
  const untouchedSignals = existingSignals.filter((signal) => signal.kind !== kind);
  const signalsByFingerprint = new Map<string, CanonicalSignal>();
  const signalsByCanonicalKey = new Map<string, CanonicalSignal>();

  for (const signal of relevantSignals) {
    signalsByCanonicalKey.set(signal.canonicalKey, signal);
    for (const fingerprint of signal.fingerprintSet) {
      signalsByFingerprint.set(fingerprint, signal);
    }
  }

  const quarantined: SignalCandidate[] = [];
  const clustered = new Map<string, MergeAccumulator>();

  for (const candidate of candidates) {
    if (candidate.kind !== kind) {
      quarantined.push(candidate);
      continue;
    }

    const fingerprint = candidate.fingerprint ?? computeFingerprint(candidate.kind, candidate.payload);
    const canonicalKey = candidate.canonicalKeyHint ?? computeCanonicalKey(candidate);
    candidate.fingerprint = fingerprint;
    candidate.canonicalKeyHint = canonicalKey;

    const exactMatch = signalsByFingerprint.get(fingerprint);
    if (exactMatch != null) {
      const merged = mergeCandidateIntoSignal(exactMatch, candidate);
      signalsByCanonicalKey.set(merged.canonicalKey, merged);
      for (const mergedFingerprint of merged.fingerprintSet) {
        signalsByFingerprint.set(mergedFingerprint, merged);
      }
      continue;
    }

    const existing = signalsByCanonicalKey.get(canonicalKey);
    const current = clustered.get(canonicalKey);
    if (current == null) {
      clustered.set(canonicalKey, {
        members: [candidate],
        existing,
      });
      continue;
    }

    current.members.push(candidate);
  }

  for (const [canonicalKey, accumulator] of clustered.entries()) {
    const existing = accumulator.existing;
    let mergedSignal = existing != null
      ? { ...existing }
      : signalFromCandidate(pickBase(accumulator.members));

    for (const member of accumulator.members) {
      mergedSignal = mergeCandidateIntoSignal(mergedSignal, member);
    }

    mergedSignal = {
      ...mergedSignal,
      canonicalKey,
      summary: summarizeSignal(mergedSignal),
    };

    const prior = signalsByCanonicalKey.get(canonicalKey);
    const finalSignal = prior != null && prior.id !== mergedSignal.id
      ? mergeSignals(prior, mergedSignal)
      : mergedSignal;

    signalsByCanonicalKey.set(canonicalKey, finalSignal);
    for (const fingerprint of finalSignal.fingerprintSet) {
      signalsByFingerprint.set(fingerprint, finalSignal);
    }
  }

  return {
    signals: [...untouchedSignals, ...signalsByCanonicalKey.values()],
    quarantined,
  };
}
