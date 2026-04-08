import type { EvidenceRecord, QualityGateResult, QualityIssue, SignalCandidate } from './types.js';
import { normalize } from './types.js';

const MAX_TECH_NAME_LENGTH = 60;
const MAX_TECH_WORDS = 4;
const MIN_RATIONALE_LENGTH = 8;
const MAX_RATIONALE_LENGTH = 150;
const BULLET_MARKER_PATTERN = /^\s*[-*+]\s+/gm;
const RAW_MARKDOWN_PATTERN = /(^\s*[-*+]\s+)|(\|.*\|)|(^#{1,6}\s)|(```)|(\*\*.+?\*\*)/m;
const PROMPT_LIKE_PATTERN = /^(task:|expected outcome:|required tools:|required skills:|must do:|must not do:|context:|you are\b|research how to\b|create\b|build\b|rewrite\b|review\b|i'?m building\b)/i;

export function evaluateCandidate(candidate: SignalCandidate, evidence: EvidenceRecord[]): QualityGateResult {
  if (candidate.kind === 'tech_preference') {
    return evaluateTechPreference(candidate, evidence);
  }

  if (candidate.kind === 'work_style') {
    return evaluateWorkStyle(candidate, evidence);
  }

  if (candidate.kind === 'profile_fact') {
    return evaluateProfileFact(candidate, evidence);
  }

  if (candidate.kind === 'decision') {
    return evaluateDecision(candidate, evidence);
  }

  if (candidate.kind === 'pain_point') {
    return evaluatePainPoint(candidate, evidence);
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

const MIN_CLAIM_LENGTH = 8;
const MAX_CLAIM_LENGTH = 150;
const MAX_WORK_STYLE_RATIONALE_LENGTH = 150;
const AI_SUBJECT_PATTERN = /AI\s*助手|Claude|系统|model/i;

export function evaluateWorkStyle(candidate: SignalCandidate, evidence: EvidenceRecord[]): QualityGateResult {
  if (candidate.kind !== 'work_style') {
    return {
      candidateId: candidate.id,
      decision: 'reject',
      score: 0,
      issues: [createIssue('missing_required', 'Candidate kind must be work_style.')],
    };
  }

  const issues: QualityIssue[] = [];
  const { dimension, claim, rationale, frequency } = candidate.payload;
  const trimmedClaim = claim.trim();
  const trimmedRationale = rationale?.trim() ?? '';

  if (dimension.trim().length === 0) {
    issues.push(createIssue('missing_required', 'dimension is required.'));
  }

  if (trimmedClaim.length === 0) {
    issues.push(createIssue('missing_required', 'claim is required.'));
  }

  if (trimmedClaim.length > 0 && trimmedClaim.length < MIN_CLAIM_LENGTH) {
    issues.push(createIssue('too_vague', `claim is too short (${trimmedClaim.length} chars < ${MIN_CLAIM_LENGTH}).`));
  }

  if (trimmedClaim.length > MAX_CLAIM_LENGTH) {
    issues.push(createIssue('too_long', `claim exceeds ${MAX_CLAIM_LENGTH} chars.`));
  }

  if (trimmedRationale.length > MAX_WORK_STYLE_RATIONALE_LENGTH) {
    issues.push(createIssue('echo_raw_text', `rationale exceeds ${MAX_WORK_STYLE_RATIONALE_LENGTH} chars.`));
  }

  if (lineBreakCount(trimmedClaim) > 2 || bulletCount(trimmedClaim) > 3) {
    issues.push(createIssue('echo_raw_text', 'claim contains raw text formatting (line breaks or bullet points).'));
  }

  if (AI_SUBJECT_PATTERN.test(trimmedClaim)) {
    issues.push(createIssue('no_actionability', 'claim describes AI behavior, not user behavior.'));
  }

  if (frequency === 'once' && evidence.length <= 1) {
    issues.push(createIssue('single_occurrence_low_trust', 'Single occurrence with frequency=once is not a stable pattern.'));
  }

  if (evidence.length === 0) {
    issues.push(createIssue('weak_evidence', 'No supporting evidence records were provided.'));
  }

  const normalizedRawText = candidate.rawText?.trim() ?? '';
  if (normalizedRawText.length > 0) {
    const claimOverlap = overlapRatio(trimmedClaim, normalizedRawText);
    if (normalizedRawText.length > trimmedClaim.length + 20 && claimOverlap >= 0.85) {
      issues.push(createIssue('echo_raw_text', 'claim directly copies raw chat text.'));
    }
  }

  const rejectCodes = new Set<QualityIssue['code']>(['missing_required', 'too_vague', 'no_actionability', 'single_occurrence_low_trust']);
  const quarantineCodes = new Set<QualityIssue['code']>(['echo_raw_text', 'too_long']);
  const mergeCodes = new Set<QualityIssue['code']>(['weak_evidence']);
  let score = 100;

  for (const issue of issues) {
    switch (issue.code) {
      case 'echo_raw_text':
      case 'too_long':
        score -= 45;
        break;
      case 'too_vague':
      case 'missing_required':
      case 'no_actionability':
      case 'single_occurrence_low_trust':
        score -= 60;
        break;
      case 'weak_evidence':
        score -= 20;
        break;
      default:
        score -= 10;
        break;
    }
  }

  const wsDecision = issues.some((issue) => rejectCodes.has(issue.code))
    ? 'reject'
    : issues.some((issue) => quarantineCodes.has(issue.code))
      ? 'quarantine'
      : issues.some((issue) => mergeCodes.has(issue.code))
        ? 'needs_merge'
        : 'accept';

  return {
    candidateId: candidate.id,
    decision: wsDecision,
    score: Math.max(0, score),
    issues,
  };
}

const MIN_PROFILE_CLAIM_LENGTH = 8;
const MAX_PROFILE_CLAIM_LENGTH = 100;
const MAX_PROFILE_RATIONALE_LENGTH = 150;
const PROJECT_EXECUTION_DETAIL_PATTERN = /^\s*(修改|添加|删除|创建|更新|新增|移除|调整)\s*(了|过)?\s*(文件|代码|配置|函数|方法|接口|组件|表|字段)/;
const VALID_DIMENSIONS = new Set(['role', 'responsibility', 'focus_area']);

export function evaluateProfileFact(candidate: SignalCandidate, evidence: EvidenceRecord[]): QualityGateResult {
  if (candidate.kind !== 'profile_fact') {
    return {
      candidateId: candidate.id,
      decision: 'reject',
      score: 0,
      issues: [createIssue('missing_required', 'Candidate kind must be profile_fact.')],
    };
  }

  const issues: QualityIssue[] = [];
  const { dimension, claim, scope, rationale } = candidate.payload;
  const trimmedClaim = claim.trim();
  const trimmedRationale = rationale?.trim() ?? '';
  const normalizedRawText = candidate.rawText?.trim() ?? '';
  const highestTrust = getHighestTrust(evidence);
  const independentEvidenceCount = new Set(evidence.map((e) => e.id)).size;

  if (!VALID_DIMENSIONS.has(dimension)) {
    issues.push(createIssue('missing_required', `dimension must be one of: role, responsibility, focus_area. Got: "${dimension}".`));
  }

  if (trimmedClaim.length === 0) {
    issues.push(createIssue('missing_required', 'claim is required.'));
  }

  if (trimmedClaim.length > 0 && trimmedClaim.length < MIN_PROFILE_CLAIM_LENGTH) {
    issues.push(createIssue('too_vague', `claim is too short (${trimmedClaim.length} chars < ${MIN_PROFILE_CLAIM_LENGTH}).`));
  }

  if (trimmedClaim.length > MAX_PROFILE_CLAIM_LENGTH) {
    issues.push(createIssue('too_long', `claim exceeds ${MAX_PROFILE_CLAIM_LENGTH} chars.`));
  }

  if (trimmedRationale.length > MAX_PROFILE_RATIONALE_LENGTH) {
    issues.push(createIssue('echo_raw_text', `rationale exceeds ${MAX_PROFILE_RATIONALE_LENGTH} chars.`));
  }

  if (lineBreakCount(trimmedClaim) > 2 || bulletCount(trimmedClaim) > 3) {
    issues.push(createIssue('echo_raw_text', 'claim contains raw text formatting (line breaks or bullet points).'));
  }

  if (hasMarkdownEcho(trimmedClaim)) {
    issues.push(createIssue('echo_raw_text', 'claim contains markdown formatting — likely raw chat echo.'));
  }

  if (normalizedRawText.length > 0) {
    const claimOverlap = overlapRatio(trimmedClaim, normalizedRawText);
    if (normalizedRawText.length > trimmedClaim.length + 20 && claimOverlap >= 0.85) {
      issues.push(createIssue('echo_raw_text', 'claim directly copies raw chat text.'));
    }
  }

  if (scope === 'global' && PROJECT_EXECUTION_DETAIL_PATTERN.test(trimmedClaim)) {
    issues.push(createIssue('no_actionability', 'global scope profile_fact must not contain project-specific execution details.'));
  }

  if (highestTrust < 4 && independentEvidenceCount < 2) {
    issues.push(createIssue('weak_evidence', 'profile_fact requires trustScore >= 4 or at least 2 independent evidence records.'));
  }

  if (evidence.length === 0) {
    issues.push(createIssue('weak_evidence', 'No supporting evidence records were provided.'));
  }

  const pfRejectCodes = new Set<QualityIssue['code']>(['missing_required', 'too_vague', 'no_actionability']);
  const pfQuarantineCodes = new Set<QualityIssue['code']>(['echo_raw_text', 'too_long']);
  const pfMergeCodes = new Set<QualityIssue['code']>(['weak_evidence']);
  let pfScore = 100;

  for (const issue of issues) {
    switch (issue.code) {
      case 'echo_raw_text':
      case 'too_long':
        pfScore -= 45;
        break;
      case 'too_vague':
      case 'missing_required':
      case 'no_actionability':
        pfScore -= 60;
        break;
      case 'weak_evidence':
        pfScore -= 20;
        break;
      default:
        pfScore -= 10;
        break;
    }
  }

  const pfDecision = issues.some((issue) => pfRejectCodes.has(issue.code))
    ? 'reject'
    : issues.some((issue) => pfQuarantineCodes.has(issue.code))
      ? 'quarantine'
      : issues.some((issue) => pfMergeCodes.has(issue.code))
        ? 'needs_merge'
        : 'accept';

  return {
    candidateId: candidate.id,
    decision: pfDecision,
    score: Math.max(0, pfScore),
    issues,
  };
}

const MIN_DECISION_LENGTH = 8;
const MAX_DECISION_LENGTH = 200;
const MAX_DECISION_RATIONALE_LENGTH = 150;
const GENERIC_DECISION_PATTERN = /^(做了优化|改了实现|优化了一下|调整了|处理了|改了|修了|弄了)$/;
const DECISION_REJECT_TITLE_PATTERN = /^(问题|已修复|TODO|Review|PRD已完成|Bug|修复|完成|待处理|待办)$/i;

export function evaluateDecision(candidate: SignalCandidate, evidence: EvidenceRecord[]): QualityGateResult {
  if (candidate.kind !== 'decision') {
    return {
      candidateId: candidate.id,
      decision: 'reject',
      score: 0,
      issues: [createIssue('missing_required', 'Candidate kind must be decision.')],
    };
  }

  const issues: QualityIssue[] = [];
  const { topic, decision, rationale, alternatives } = candidate.payload;
  const trimmedDecision = decision.trim();
  const trimmedRationale = rationale.trim();
  const trimmedTopic = topic.trim();
  const highestTrust = getHighestTrust(evidence);

  if (trimmedTopic.length === 0) {
    issues.push(createIssue('missing_required', 'topic is required.'));
  }

  if (trimmedDecision.length === 0) {
    issues.push(createIssue('missing_required', 'decision must not be empty.'));
  }

  if (DECISION_REJECT_TITLE_PATTERN.test(trimmedDecision)) {
    issues.push(createIssue('no_actionability', `decision is a status word, not a real decision: "${trimmedDecision}".`));
  }

  if (GENERIC_DECISION_PATTERN.test(trimmedDecision)) {
    issues.push(createIssue('too_vague', `decision is too generic: "${trimmedDecision}".`));
  }

  if (trimmedDecision.length > 0 && trimmedDecision.length < MIN_DECISION_LENGTH) {
    issues.push(createIssue('too_vague', `decision is too short (${trimmedDecision.length} chars < ${MIN_DECISION_LENGTH}).`));
  }

  if (trimmedDecision.length > MAX_DECISION_LENGTH) {
    issues.push(createIssue('too_long', `decision exceeds ${MAX_DECISION_LENGTH} chars.`));
  }

  if (trimmedRationale.length === 0) {
    issues.push(createIssue('missing_rationale', 'rationale must contain at least one specific reason.'));
  }

  if (trimmedRationale.length > MAX_DECISION_RATIONALE_LENGTH) {
    issues.push(createIssue('too_long', `rationale exceeds ${MAX_DECISION_RATIONALE_LENGTH} chars.`));
  }

  if (lineBreakCount(trimmedRationale) > 2 || bulletCount(trimmedRationale) > 3) {
    issues.push(createIssue('echo_raw_text', 'rationale contains raw text formatting.'));
  }

  const hasHighTrust = highestTrust >= 4;
  const hasMultipleEvidence = evidence.length >= 2;
  const hasClearSemantics = alternatives.length > 0 || (trimmedRationale.length >= 20 && trimmedDecision.length >= 15);
  if (!hasHighTrust && !hasMultipleEvidence && !hasClearSemantics) {
    issues.push(createIssue('weak_evidence', 'Decision needs trustScore >= 4, multiple evidence, or clear decision semantics.'));
  }

  if (evidence.length === 0) {
    issues.push(createIssue('weak_evidence', 'No supporting evidence records were provided.'));
  }

  const dRejectCodes = new Set<QualityIssue['code']>(['missing_required', 'too_vague', 'missing_rationale', 'no_actionability']);
  const dQuarantineCodes = new Set<QualityIssue['code']>(['echo_raw_text', 'too_long']);
  const dMergeCodes = new Set<QualityIssue['code']>(['weak_evidence']);
  let dScore = 100;

  for (const issue of issues) {
    switch (issue.code) {
      case 'echo_raw_text':
      case 'too_long':
        dScore -= 45;
        break;
      case 'too_vague':
      case 'missing_required':
      case 'missing_rationale':
      case 'no_actionability':
        dScore -= 60;
        break;
      case 'weak_evidence':
        dScore -= 20;
        break;
      default:
        dScore -= 10;
        break;
    }
  }

  const dDecision = issues.some((issue) => dRejectCodes.has(issue.code))
    ? 'reject'
    : issues.some((issue) => dQuarantineCodes.has(issue.code))
      ? 'quarantine'
      : issues.some((issue) => dMergeCodes.has(issue.code))
        ? 'needs_merge'
        : 'accept';

  return {
    candidateId: candidate.id,
    decision: dDecision,
    score: Math.max(0, dScore),
    issues,
  };
}

const MIN_PROBLEM_LENGTH = 10;
const MAX_PROBLEM_LENGTH = 200;
const MAX_PP_DIAGNOSIS_LENGTH = 150;
const MAX_PP_WORKAROUND_LENGTH = 150;
const VAGUE_PROBLEM_PATTERN = /^(这里有点麻烦|有个问题|不太行|有bug|出错了|不好用|有点问题)$/i;

export function evaluatePainPoint(candidate: SignalCandidate, evidence: EvidenceRecord[]): QualityGateResult {
  if (candidate.kind !== 'pain_point') {
    return {
      candidateId: candidate.id,
      decision: 'reject',
      score: 0,
      issues: [createIssue('missing_required', 'Candidate kind must be pain_point.')],
    };
  }

  const issues: QualityIssue[] = [];
  const { problem, diagnosis, workaround } = candidate.payload;
  const trimmedProblem = problem.trim();
  const trimmedDiagnosis = diagnosis?.trim() ?? '';
  const trimmedWorkaround = workaround?.trim() ?? '';
  const highestTrust = getHighestTrust(evidence);

  if (trimmedProblem.length === 0) {
    issues.push(createIssue('missing_required', 'problem must not be empty.'));
  }

  if (trimmedProblem.length > 0 && trimmedProblem.length < MIN_PROBLEM_LENGTH) {
    issues.push(createIssue('too_vague', `problem is too short (${trimmedProblem.length} chars < ${MIN_PROBLEM_LENGTH}).`));
  }

  if (trimmedProblem.length > MAX_PROBLEM_LENGTH) {
    issues.push(createIssue('too_long', `problem exceeds ${MAX_PROBLEM_LENGTH} chars.`));
  }

  if (VAGUE_PROBLEM_PATTERN.test(trimmedProblem)) {
    issues.push(createIssue('too_vague', `problem is not a concrete engineering problem: "${trimmedProblem}".`));
  }

  if (trimmedDiagnosis.length === 0 && trimmedWorkaround.length === 0) {
    issues.push(createIssue('missing_required', 'At least one of diagnosis or workaround is required.'));
  }

  if (trimmedDiagnosis.length > MAX_PP_DIAGNOSIS_LENGTH) {
    issues.push(createIssue('too_long', `diagnosis exceeds ${MAX_PP_DIAGNOSIS_LENGTH} chars.`));
  }

  if (trimmedWorkaround.length > MAX_PP_WORKAROUND_LENGTH) {
    issues.push(createIssue('too_long', `workaround exceeds ${MAX_PP_WORKAROUND_LENGTH} chars.`));
  }

  if (lineBreakCount(trimmedProblem) > 2 || bulletCount(trimmedProblem) > 3) {
    issues.push(createIssue('echo_raw_text', 'problem contains raw text formatting.'));
  }

  if (evidence.length === 1 && highestTrust <= 2 && candidate.confidence < 0.6) {
    issues.push(createIssue('single_occurrence_low_trust', 'Single low-trust complaint with no follow-up should not enter canonical layer.'));
  }

  if (evidence.length === 0) {
    issues.push(createIssue('weak_evidence', 'No supporting evidence records were provided.'));
  }

  const ppRejectCodes = new Set<QualityIssue['code']>(['missing_required', 'too_vague', 'single_occurrence_low_trust']);
  const ppQuarantineCodes = new Set<QualityIssue['code']>(['echo_raw_text', 'too_long']);
  const ppMergeCodes = new Set<QualityIssue['code']>(['weak_evidence']);
  let ppScore = 100;

  for (const issue of issues) {
    switch (issue.code) {
      case 'echo_raw_text':
      case 'too_long':
        ppScore -= 45;
        break;
      case 'too_vague':
      case 'missing_required':
      case 'single_occurrence_low_trust':
        ppScore -= 60;
        break;
      case 'weak_evidence':
        ppScore -= 20;
        break;
      default:
        ppScore -= 10;
        break;
    }
  }

  const ppDecision = issues.some((issue) => ppRejectCodes.has(issue.code))
    ? 'reject'
    : issues.some((issue) => ppQuarantineCodes.has(issue.code))
      ? 'quarantine'
      : issues.some((issue) => ppMergeCodes.has(issue.code))
        ? 'needs_merge'
        : 'accept';

  return {
    candidateId: candidate.id,
    decision: ppDecision,
    score: Math.max(0, ppScore),
    issues,
  };
}
