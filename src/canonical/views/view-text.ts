const LEAKED_METADATA_PATTERNS = [
  /<!--\s*desc:[\s\S]*?-->/gi,
  /<!--\s*generated:[\s\S]*?-->/gi,
  /<!--\s*sources:[\s\S]*?-->/gi,
  /^\s*source[s]?:\s*.+$/gim,
  /^\s*generated:\s*.+$/gim,
  /\bsourceLabel\s*:\s*[^\n]+/gi,
];

const LOGGER_PREFIX_RE = /^\s*\[(?:INFO|DEBUG|WARN(?:ING)?|ERROR|TRACE)\][^\n]*$/gim;
const RAW_MACHINE_LABEL_RE = /^\s*\[(?:in_progress|open|blocked)\]\s*/i;
const SOURCE_LABEL_RE = /^\s*\[(?:OC|CC)\]\s*/i;
const RECORD_PREFIX_RE = /^\s*\[记录\]\s*/i;
const SUBAGENT_RE = /\s*\(@[^)]*subagent\)\s*/gi;
const LOCAL_COMMAND_RE = /<\/?local-command-caveat>/gi;
const GENERIC_TAG_RE = /<\/?[\w-]+>/g;
const TOOL_LIKE_PREFIX_RE = /^\s*[a-z_][a-z0-9_]*:\s*/;
const FILE_PATH_PREFIX_RE = /^\s*(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|swift|md):\s*/i;
const ENV_LEAK_RE = /\b[A-Z][A-Z0-9_]{1,}\b\s*(?:—|:)/;

function stripKnownMetadata(input: string): string {
  let value = input;
  for (const pattern of LEAKED_METADATA_PATTERNS) {
    value = value.replace(pattern, ' ');
  }
  return value;
}

function collapseWhitespace(input: string): string {
  return input.replace(/[\t\r\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeForMeaning(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningless(input: string): boolean {
  const normalized = normalizeForMeaning(input);
  return normalized.length === 0 || /^(unknown|n a|na|null|undefined|none|todo)$/i.test(normalized);
}

function shortenAtBoundary(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  const candidates: number[] = [];
  const punctuation = ['。', '！', '？', '.', '!', '?', ';', '；', '，', ',', '、'];
  for (const mark of punctuation) {
    const idx = input.lastIndexOf(mark, maxLength);
    if (idx >= 0) candidates.push(idx + 1);
  }
  const separators = [' — ', ' - ', ': ', '：', ' / ', ' · '];
  for (const sep of separators) {
    const idx = input.lastIndexOf(sep, maxLength);
    if (idx >= 0) candidates.push(idx);
  }
  const whitespaceIdx = input.lastIndexOf(' ', maxLength);
  if (whitespaceIdx >= 0) candidates.push(whitespaceIdx);
  const boundary = Math.max(...candidates, -1);
  const trimmed = (boundary > Math.floor(maxLength * 0.55) ? input.slice(0, boundary) : input.slice(0, maxLength));
  return trimmed.replace(/\s+\S*$/, (match, offset, whole) => {
    if (whole.length <= maxLength) return match;
    const lastSpace = whole.lastIndexOf(' ');
    return lastSpace > Math.floor(maxLength * 0.55) ? '' : match;
  }).trim();
}

export function cleanViewText(input: string | null | undefined): string {
  if (input == null) return '';
  const stripped = stripKnownMetadata(String(input));
  return collapseWhitespace(stripped);
}

export function cleanProjectName(input: string | null | undefined, fallback?: string): string {
  const value = cleanViewText(input);
  if (value.length === 0 || /^(unknown|\(unknown\)|cross_project)$/i.test(value)) {
    return fallback ?? '未归类项目';
  }
  return value;
}

export function cleanTitle(input: string | null | undefined): string {
  let value = cleanViewText(input)
    .replace(SUBAGENT_RE, ' ')
    .replace(SOURCE_LABEL_RE, '')
    .replace(RECORD_PREFIX_RE, '')
    .replace(FILE_PATH_PREFIX_RE, '')
    .replace(TOOL_LIKE_PREFIX_RE, '')
    .replace(LOCAL_COMMAND_RE, ' ')
    .replace(GENERIC_TAG_RE, ' ')
    .replace(LOGGER_PREFIX_RE, ' ')
    .replace(RAW_MACHINE_LABEL_RE, ' ');
  value = collapseWhitespace(value);
  return isMeaningless(value) ? '未命名事项' : value;
}

export function areNearDuplicateTexts(a: string, b: string): boolean {
  const normalize = (value: string): string => cleanViewText(value)
    .toLowerCase()
    .replace(/[\p{P}\p{S}。.!！?？…]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const left = normalize(a);
  const right = normalize(b);
  if (left.length === 0 || right.length === 0) return false;
  return left === right || left.includes(right) || right.includes(left);
}

export function cleanEvidence(input: string | null | undefined, maxLength = 80): string {
  const cleaned = cleanViewText(input);
  if (cleaned.length === 0) return '';
  const keptLines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !ENV_LEAK_RE.test(line))
    .filter((line) => !line.includes('当前值'));
  const joined = collapseWhitespace(keptLines.join(' '));
  if (joined.length === 0) return '';
  return shortenAtBoundary(joined, maxLength);
}

export function localizeStatus(status: string | null | undefined): string {
  const value = cleanViewText(status);
  if (value.length === 0) return '待处理';
  if (value === 'in_progress') return '进行中';
  if (value === 'blocked') return '阻塞';
  if (value === 'open') return '待处理';
  return value;
}

export function localizeRecurrence(level: string | null | undefined): string {
  const value = cleanViewText(level).toLowerCase();
  if (value === 'high') return '高频';
  if (value === 'medium') return '中频';
  if (value === 'low') return '低频';
  return cleanViewText(level);
}

export function localizeStance(stance: string | null | undefined): string {
  const value = cleanViewText(stance).toLowerCase();
  if (value === 'prefer') return '偏好';
  if (value === 'avoid') return '避免';
  if (value === 'conditional') return '视场景而定';
  return cleanViewText(stance);
}

export function localizeTrust(trustScore: number, supportCount: number): string {
  const level = trustScore >= 4 ? '高' : trustScore >= 3 ? '中' : '低';
  return `${level}（${supportCount} 条证据）`;
}

export function formatDateLabel(input: string | number | Date | null | undefined): string {
  if (input == null) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const currentYear = new Date().getFullYear();
  return year === currentYear ? `${month}-${day}` : `${year}-${month}-${day}`;
}

export function formatRelativeStaleness(lastSeenAt: number, now: number): string | null {
  const elapsedDays = (now - lastSeenAt) / 86_400_000;
  if (elapsedDays > 30) return '搁置 30+ 天';
  if (elapsedDays > 14) return '搁置 2+ 周';
  if (elapsedDays > 7) return '搁置 1+ 周';
  return null;
}

export function shouldHideAsNoise(input: string | null | undefined): boolean {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) return true;
  if (LOGGER_PREFIX_RE.test(raw) || LOCAL_COMMAND_RE.test(raw)) return true;
  const cleaned = cleanTitle(raw);
  if (cleaned === '未命名事项') return true;
  if (cleaned.length < 5) return true;
  const tagStripped = raw.replace(/<[^>]+>/g, '').trim();
  if (tagStripped.length === 0) return true;
  const alnumCount = (cleaned.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const symbolCount = cleaned.length - alnumCount;
  return alnumCount === 0 || symbolCount > alnumCount * 2;
}

function normalizeForDedupe(input: string): string {
  return cleanViewText(input)
    .toLowerCase()
    .replace(/[\p{P}\p{S}“”‘’「」『』（）()\[\]{}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeByNormalizedText<T>(items: T[], getText: (item: T) => string, threshold = 1): T[] {
  const kept: Array<{ item: T; normalized: string }> = [];
  for (const item of items) {
    const normalized = normalizeForDedupe(getText(item));
    if (normalized.length === 0) continue;
    const duplicate = kept.some((entry) => (
      entry.normalized === normalized
      || entry.normalized.includes(normalized)
      || normalized.includes(entry.normalized)
      || (threshold < 1 && Math.min(entry.normalized.length, normalized.length) / Math.max(entry.normalized.length, normalized.length) >= threshold
        && (entry.normalized.includes(normalized) || normalized.includes(entry.normalized)))
    ));
    if (!duplicate) kept.push({ item, normalized });
  }
  return kept.map((entry) => entry.item);
}

export function finalizeMarkdownWithinBudget(header: string, body: string, maxChars: number): string {
  const base = `${header}${body}`;
  if (base.length <= maxChars) return base;
  if (header.length > maxChars) return header;
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) return header;

  const paragraphParts = trimmedBody.split(/\n\n+/);
  for (let count = paragraphParts.length; count >= 1; count--) {
    const candidate = `${header}${paragraphParts.slice(0, count).join('\n\n')}\n`;
    if (candidate.length <= maxChars) return candidate;
  }

  const lines = trimmedBody.split('\n');
  for (let count = lines.length; count >= 1; count--) {
    const candidate = `${header}${lines.slice(0, count).join('\n')}\n`;
    if (candidate.length <= maxChars) return candidate;
  }

  const sentences = trimmedBody.match(/[^。.!！？]+[。.!！？]?/g) ?? [];
  for (let count = sentences.length; count >= 1; count--) {
    const candidate = `${header}${sentences.slice(0, count).join('').trim()}\n`;
    if (candidate.length <= maxChars) return candidate;
  }

  return header;
}
