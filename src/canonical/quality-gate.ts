import type { EvidenceRecord, QualityGateResult, QualityIssue, SignalCandidate } from './types.js';
import { normalize } from './types.js';

const MAX_TECH_NAME_LENGTH = 60;
const MAX_TECH_WORDS = 4;
const MIN_RATIONALE_LENGTH = 8;
const MAX_RATIONALE_LENGTH = 150;
const BULLET_MARKER_PATTERN = /^\s*[-*+]\s+/gm;
const RAW_MARKDOWN_PATTERN = /(^\s*[-*+]\s+)|(\|.*\|)|(^#{1,6}\s)|(```)|(\*\*.+?\*\*)/m;
const PROMPT_LIKE_PATTERN = /^(task:|expected outcome:|required tools:|required skills:|must do:|must not do:|context:|you are\b|research how to\b|create\b|build\b|rewrite\b|review\b|i'?m building\b)/i;

/** Evaluate a candidate through the quality gate. Phase 1a: only tech_preference has rules. */
export function evaluateCandidate(candidate: SignalCandidate, evidence: EvidenceRecord[]): QualityGateResult {
  if (candidate.kind === 'tech_preference') {
    return evaluateTechPreference(candidate, evidence);
  }

  return { candidateId: candidate.id, decision: 'accept', score: 50, issues: [] };
}

function lineBreakCount(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}

function bulletCount(value: string): number {
  return (value.match(BULLET_MARKER_PATTERN) ?? []).length;
}

function createIssue(code: QualityIssue['code'], message: string): QualityIssue {
  return { code, message };
}

function hasMarkdownEcho(value: string): boolean {
  return RAW_MARKDOWN_PATTERN.test(value);
}

function overlapRatio(left: string, right: string): number {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);

  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
  return longer.includes(shorter) ? shorter.length / longer.length : 0;
}

function getHighestTrust(evidence: EvidenceRecord[]): number {
  return evidence.reduce((maxTrust, entry) => Math.max(maxTrust, entry.trustScore), 0);
}

export function evaluateTechPreference(candidate: SignalCandidate, evidence: EvidenceRecord[]): QualityGateResult {
  if (candidate.kind !== 'tech_preference') {
    return {
      candidateId: candidate.id,
      decision: 'reject',
      score: 0,
      issues: [createIssue('missing_required', 'Candidate kind must be tech_preference.')],
    };
  }

  const issues: QualityIssue[] = [];
  const { technology, category, stance, rationale, conditions } = candidate.payload;
  const normalizedTechnology = normalize(technology);
  const trimmedRationale = rationale.trim();
  const normalizedRawText = candidate.rawText?.trim() ?? '';
  const highestTrust = getHighestTrust(evidence);

  if (technology.trim().length === 0 || category.trim().length === 0 || stance.trim().length === 0) {
    issues.push(createIssue('missing_required', 'technology/category/stance are required.'));
  }

  if (trimmedRationale.length === 0) {
    issues.push(createIssue('missing_rationale', 'rationale must not be empty.'));
  }

  if (stance === 'conditional' && (conditions == null || conditions.length === 0)) {
    issues.push(createIssue('missing_required', 'conditional tech_preference requires conditions.'));
  }

  if (
    technology.includes('\n')
    || technology.length > MAX_TECH_NAME_LENGTH
    || normalizedTechnology.split(' ').length > MAX_TECH_WORDS
  ) {
    issues.push(createIssue('too_long', 'technology must be a normalized tech name, not a paragraph.'));
  }

  if (trimmedRationale.length > MAX_RATIONALE_LENGTH) {
    issues.push(createIssue('too_long', 'rationale exceeds the Phase 1a length budget.'));
  }

  if (normalizedTechnology.length < 2 || trimmedRationale.length < MIN_RATIONALE_LENGTH) {
    issues.push(createIssue('too_vague', 'technology or rationale is too vague.'));
  }

  const rationaleOverlap = normalizedRawText.length === 0 ? 0 : overlapRatio(trimmedRationale, normalizedRawText);
  if (
    lineBreakCount(trimmedRationale) > 2
    || bulletCount(trimmedRationale) > 3
    || hasMarkdownEcho(trimmedRationale)
    || (normalizedRawText.length > trimmedRationale.length + 20 && rationaleOverlap >= 0.85)
  ) {
    issues.push(createIssue('echo_raw_text', 'rationale looks like raw text echo and should be quarantined.'));
  }

  if (evidence.length === 0) {
    issues.push(createIssue('weak_evidence', 'No supporting evidence records were provided.'));
  }

  if (evidence.length === 1 && highestTrust <= 2 && candidate.confidence < 0.6) {
    issues.push(createIssue('single_occurrence_low_trust', 'Single low-trust observation should merge with stronger evidence first.'));
  }

  const sessionEvidenceOnly = evidence.length > 0 && evidence.every((entry) => entry.sourceKind === 'session_message');
  if (sessionEvidenceOnly && (PROMPT_LIKE_PATTERN.test(trimmedRationale) || PROMPT_LIKE_PATTERN.test(normalizedRawText))) {
    issues.push(createIssue('no_actionability', 'Prompt-like session text is not a durable tech preference.'));
  }

  const rejectCodes = new Set<QualityIssue['code']>(['missing_required', 'missing_rationale', 'too_vague', 'no_actionability']);
  const quarantineCodes = new Set<QualityIssue['code']>(['echo_raw_text', 'too_long']);
  const mergeCodes = new Set<QualityIssue['code']>(['weak_evidence', 'single_occurrence_low_trust', 'no_actionability']);
  let score = 100;

  for (const issue of issues) {
    switch (issue.code) {
      case 'echo_raw_text':
      case 'too_long':
        score -= 45;
        break;
      case 'too_vague':
      case 'missing_required':
      case 'missing_rationale':
        score -= 60;
        break;
      case 'weak_evidence':
      case 'single_occurrence_low_trust':
        score -= 20;
        break;
      default:
        score -= 10;
        break;
    }
  }

  const decision = issues.some((issue) => rejectCodes.has(issue.code))
    ? 'reject'
    : issues.some((issue) => quarantineCodes.has(issue.code))
      ? 'quarantine'
      : issues.some((issue) => mergeCodes.has(issue.code))
        ? 'needs_merge'
        : 'accept';

  return {
    candidateId: candidate.id,
    decision,
    score: Math.max(0, score),
    issues,
  };
}
