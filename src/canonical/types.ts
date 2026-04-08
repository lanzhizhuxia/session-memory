import { createHash } from 'node:crypto';

export type EvidenceSourceKind =
  | 'session_message'
  | 'session_todo'
  | 'session_summary'
  | 'memory_file'
  | 'rule_file'
  | 'session_note'
  | 'derived_note';

export interface EvidenceRecord {
  id: string;
  sourceKind: EvidenceSourceKind;
  sourceLabel: string;
  projectId?: string;
  projectName?: string;
  canonicalProjectPath?: string;
  sessionId?: string;
  messageId?: string;
  todoId?: string;
  filePath?: string;
  content: string;
  contentHash: string;
  capturedAt: number;
  observedAt?: string;
  authorRole?: 'user' | 'assistant' | 'system' | 'tool';
  trustScore: 1 | 2 | 3 | 4 | 5;
  recencyScore: number;
  extractionHints?: string[];
  metadata?: Record<string, string | number | boolean | string[]>;
}

export type SignalKind =
  | 'decision'
  | 'tech_preference'
  | 'pain_point'
  | 'work_style'
  | 'profile_fact'
  | 'timeline_event'
  | 'open_thread';

export interface SignalCandidateBase {
  id: string;
  kind: SignalKind;
  evidenceIds: string[];
  primaryEvidenceId: string;
  projectId?: string;
  projectName?: string;
  canonicalProjectPath?: string;
  confidence: number;
  trustScore: 1 | 2 | 3 | 4 | 5;
  sourceLabels?: string[];
  observedAt?: string;
  extractor: string;
  rawText?: string;
  fingerprint?: string;
  canonicalKeyHint?: string;
}

export interface DecisionPayload {
  topic: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  trigger?: string;
  scope: 'project' | 'cross_project' | 'personal';
}

export interface TechPreferencePayload {
  category: string;
  technology: string;
  stance: 'prefer' | 'avoid' | 'conditional';
  rationale: string;
  conditions?: string[];
}

export interface PainPointPayload {
  problem: string;
  symptoms?: string[];
  diagnosis?: string;
  workaround?: string;
  recurrence: 'low' | 'medium' | 'high';
}

export interface WorkStylePayload {
  dimension: string;
  claim: string;
  rationale?: string;
  frequency?: 'once' | 'repeated' | 'habitual';
}

export interface ProfileFactPayload {
  dimension: 'role' | 'responsibility' | 'focus_area';
  claim: string;
  scope: 'global' | 'project';
  rationale?: string;
}

export interface TimelineEventPayload {
  eventType: 'milestone' | 'decision' | 'incident' | 'delivery' | 'refactor';
  title: string;
  summary: string;
  date: string;
}

export interface OpenThreadPayload {
  threadType: 'todo' | 'risk' | 'question' | 'followup';
  title: string;
  status: 'open' | 'blocked' | 'in_progress';
  nextAction?: string;
  ownerHint?: string;
}

export type SignalCandidate =
  | (SignalCandidateBase & { kind: 'decision'; payload: DecisionPayload })
  | (SignalCandidateBase & { kind: 'tech_preference'; payload: TechPreferencePayload })
  | (SignalCandidateBase & { kind: 'pain_point'; payload: PainPointPayload })
  | (SignalCandidateBase & { kind: 'work_style'; payload: WorkStylePayload })
  | (SignalCandidateBase & { kind: 'profile_fact'; payload: ProfileFactPayload })
  | (SignalCandidateBase & { kind: 'timeline_event'; payload: TimelineEventPayload })
  | (SignalCandidateBase & { kind: 'open_thread'; payload: OpenThreadPayload });

export type QualityDecision = 'accept' | 'reject' | 'needs_merge' | 'quarantine';

export interface QualityIssue {
  code:
    | 'too_vague'
    | 'too_long'
    | 'echo_raw_text'
    | 'missing_required'
    | 'missing_rationale'
    | 'weak_evidence'
    | 'single_occurrence_low_trust'
    | 'no_actionability'
    | 'invalid_date';
  message: string;
}

export interface QualityGateResult {
  candidateId: string;
  decision: QualityDecision;
  score: number;
  issues: QualityIssue[];
}

export interface QualityGate {
  evaluate(candidate: SignalCandidate, supportingEvidence: EvidenceRecord[]): QualityGateResult;
}

export interface CanonicalSignalBase {
  id: string;
  kind: SignalKind;
  canonicalKey: string;
  fingerprintSet: string[];
  status: 'active' | 'superseded' | 'archived';
  projectIds: string[];
  projectNames: string[];
  evidenceIds: string[];
  sourceLabels: string[];
  trustScore: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  supportCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastPublishedAt?: number;
  summary: string;
  mergeNotes?: string[];
}

export type CanonicalSignal =
  | (CanonicalSignalBase & { kind: 'decision'; payload: DecisionPayload })
  | (CanonicalSignalBase & { kind: 'tech_preference'; payload: TechPreferencePayload })
  | (CanonicalSignalBase & { kind: 'pain_point'; payload: PainPointPayload })
  | (CanonicalSignalBase & { kind: 'work_style'; payload: WorkStylePayload })
  | (CanonicalSignalBase & { kind: 'profile_fact'; payload: ProfileFactPayload })
  | (CanonicalSignalBase & { kind: 'timeline_event'; payload: TimelineEventPayload })
  | (CanonicalSignalBase & { kind: 'open_thread'; payload: OpenThreadPayload });

export type ViewBuildMode = 'full_rebuild' | 'append_only' | 'rolling_window';

export interface ViewBudget {
  viewId: string;
  buildMode: ViewBuildMode;
  maxSignals?: number;
  maxChars: number;
  maxSections?: number;
  maxItemsTotal?: number;
  maxItemsPerSection?: number;
  sections?: string[];
  overflowPolicy: 'truncate' | 'summarize' | 'drop_low_score';
}

export interface PublishedViewSection {
  title: string;
  signalIds: string[];
  markdown: string;
}

export interface PublishedView {
  viewId: string;
  title: string;
  generatedAt: number;
  sourceSignalIds: string[];
  budget: ViewBudget;
  sections: PublishedViewSection[];
  markdown: string;
}

export function normalize(input: string, maxChars?: number): string {
  const normalized = input
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (maxChars == null || normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(0, maxChars).trim();
}

function stableNormalizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalize(value);
  }

  if (
    typeof value === 'number'
    || typeof value === 'boolean'
    || value == null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stableNormalizeValue(item));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, stableNormalizeValue(entryValue)]);

    return Object.fromEntries(entries);
  }

  return String(value);
}

export function computeFingerprint(kind: SignalKind, payload: unknown): string {
  const stablePayload = stableNormalizeValue(payload);
  return createHash('sha256')
    .update(`${kind}:${JSON.stringify(stablePayload)}`)
    .digest('hex');
}

function firstChars(value: string, maxChars: number): string {
  return value.slice(0, maxChars);
}

export function generateId(): string {
  return createHash('sha256')
    .update(Date.now().toString() + Math.random().toString())
    .digest('hex')
    .slice(0, 12);
}

export function computeCanonicalKey(candidate: SignalCandidate): string {
  switch (candidate.kind) {
    case 'tech_preference': {
      const scope = normalize(candidate.canonicalProjectPath ?? 'global');
      return `${scope}:${normalize(candidate.payload.technology)}:${candidate.payload.stance}`;
    }
    case 'work_style':
      return `${normalize(candidate.payload.dimension)}:${normalize(firstChars(candidate.payload.claim, 20))}`;
    case 'decision':
      return `${normalize(candidate.projectName ?? 'cross_project')}:${normalize(firstChars(candidate.payload.topic, 30))}`;
    case 'pain_point':
      return `${normalize(candidate.projectName ?? 'global')}:${normalize(firstChars(candidate.payload.problem, 30))}`;
    case 'profile_fact':
      return `${normalize(candidate.payload.dimension)}:${normalize(firstChars(candidate.payload.claim, 20))}`;
    case 'timeline_event':
      return `${normalize(candidate.projectName ?? 'global')}:${normalize(candidate.payload.date)}:${normalize(firstChars(candidate.payload.summary, 20))}`;
    case 'open_thread':
      return `${normalize(candidate.projectName ?? 'global')}:${normalize(firstChars(candidate.payload.title, 30))}`;
  }
}
