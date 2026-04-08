export interface ProjectSummaryContext {
  projectName: string;
  signalCount: number;
  timelineTitles: string[];
  decisionTopics: string[];
  openThreadTitles: string[];
}

export interface ProjectSummaryAIConfig {
  api_key?: string;
  api_base_url?: string;
  model?: string;
}

interface ProjectSummaryResult {
  project: string;
  summary: string;
}

const UNKNOWN_PROJECT_SUMMARY = '(unknown)';
const MAX_AI_RETRIES = 2;
const AI_RETRY_BASE_MS = 1000;
const SUMMARY_MAX_CHARS = 40;
const SEMANTIC_SUMMARY_PATTERN = /用于|帮助|面向|服务|支持|提供|实现|连接|驱动|管理|分析|监控|记录|整理|检索|执行|优化|回测|交易|系统|平台|工具|助手/;
const KEYWORD_LIST_PATTERN = /[、,，]\s*[A-Za-z\u4e00-\u9fa5]+(?:\s*[、,，]\s*[A-Za-z\u4e00-\u9fa5]+)+/;

function normalizeProjectName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').trim();
}

function buildUnknownMap(projectContexts: ProjectSummaryContext[]): Map<string, string> {
  return new Map(projectContexts.map((context) => [context.projectName, UNKNOWN_PROJECT_SUMMARY]));
}

function isValidProjectSummary(projectName: string, summary: string): boolean {
  const trimmed = summary.trim();
  if (trimmed.length < 5 || trimmed.length > SUMMARY_MAX_CHARS) return false;
  if (trimmed.includes('/')) return false;
  const normalizedProjectName = normalizeProjectName(projectName);
  const normalizedSummary = normalizeProjectName(trimmed);
  if (normalizedSummary === normalizedProjectName) return false;
  if (normalizedProjectName.length >= 3 && normalizedSummary.includes(normalizedProjectName)) return false;
  if (KEYWORD_LIST_PATTERN.test(trimmed) && !SEMANTIC_SUMMARY_PATTERN.test(trimmed)) return false;
  if (!SEMANTIC_SUMMARY_PATTERN.test(trimmed)) return false;
  return true;
}

function buildPrompt(projectContexts: ProjectSummaryContext[]): string {
  const projectBlocks = projectContexts.map((context, index) => {
    const lines = [
      `${index + 1}. ${context.projectName}`,
      `   - 工作记录：${context.timelineTitles.length > 0 ? context.timelineTitles.join('，') : '(none)'}`,
      `   - 关键决策：${context.decisionTopics.length > 0 ? context.decisionTopics.join('，') : '(none)'}`,
      `   - 未完成线索：${context.openThreadTitles.length > 0 ? context.openThreadTitles.join('，') : '(none)'}`,
    ];
    return lines.join('\n');
  });

  return [
    '你是一个项目分析助手。根据以下项目的工作记录，为每个项目写一句话描述（中文，≤40字）。',
    '描述应该说明项目的用途、目标或服务对象。',
    '',
    '规则：',
    '- 不要重复项目名',
    '- 不要列举关键词或用 / 分隔',
    '- 不要总结最近任务，而是描述项目本身的定位',
    '- 如果证据不足以判断项目用途，返回空字符串 ""',
    '',
    '项目列表：',
    ...projectBlocks,
    '',
    '输出 JSON（严格格式）：',
    '[{"project":"项目名","summary":"描述"}]',
  ].join('\n');
}

async function callProjectSummaryAI(
  projectContexts: ProjectSummaryContext[],
  config: Required<ProjectSummaryAIConfig>,
): Promise<ProjectSummaryResult[] | null> {
  const prompt = buildPrompt(projectContexts);

  for (let attempt = 0; attempt <= MAX_AI_RETRIES; attempt++) {
    try {
      const res = await fetch(`${config.api_base_url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1024,
          temperature: 0,
          messages: [
            { role: 'system', content: 'Output only strict JSON. No markdown, no explanation.' },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_AI_RETRIES) {
          const delayMs = AI_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        console.error(`  Project summary AI error: ${res.status} ${body.slice(0, 200)}`);
        return null;
      }

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (text.length === 0) return null;

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (!Array.isArray(parsed)) return null;

      return parsed
        .filter((item): item is ProjectSummaryResult => (
          typeof item === 'object'
          && item !== null
          && typeof (item as { project?: unknown }).project === 'string'
          && typeof (item as { summary?: unknown }).summary === 'string'
        ));
    } catch (error) {
      if (attempt < MAX_AI_RETRIES) {
        const delayMs = AI_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      console.error('  Project summary AI failed:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  return null;
}

export async function generateProjectDescriptions(
  projectContexts: ProjectSummaryContext[],
  aiConfig: ProjectSummaryAIConfig,
): Promise<Map<string, string>> {
  const result = buildUnknownMap(projectContexts);
  const eligibleContexts = projectContexts.filter((context) => context.signalCount >= 3);

  if (
    eligibleContexts.length === 0
    || aiConfig.api_key == null
    || aiConfig.api_base_url == null
    || aiConfig.model == null
  ) {
    return result;
  }

  const aiResults = await callProjectSummaryAI(eligibleContexts, {
    api_key: aiConfig.api_key,
    api_base_url: aiConfig.api_base_url,
    model: aiConfig.model,
  });
  if (aiResults == null) return result;

  const byProject = new Map(aiResults.map((item) => [item.project, item.summary]));
  for (const context of eligibleContexts) {
    const summary = byProject.get(context.projectName)?.trim() ?? '';
    if (isValidProjectSummary(context.projectName, summary)) {
      result.set(context.projectName, summary);
    }
  }

  return result;
}
