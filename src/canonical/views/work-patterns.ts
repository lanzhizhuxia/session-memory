import type { PublishedView, ViewBudget } from '../types.js';

export const WORK_PATTERNS_BUDGET: ViewBudget = {
  viewId: 'work_patterns',
  buildMode: 'full_rebuild',
  maxChars: 16000,
  overflowPolicy: 'drop_low_score',
  modality: 'derived_view',
  retention: { mode: 'full' },
};

export type WorkPatternsViewInput = {
  taskTypes: string;
  hourDistribution: string;
  firstMsgPatterns: string;
};

export function compileWorkPatternsView(
  markdown: string,
  budget: ViewBudget,
  _sourceSummary: string,
): PublishedView {
  const generatedAt = Date.now();

  const bounded = markdown.length > budget.maxChars
    ? `${markdown.slice(0, budget.maxChars - 50)}\n\n<!-- truncated to budget: ${budget.maxChars} chars -->\n`
    : markdown;

  return {
    viewId: budget.viewId,
    title: '工作模式',
    generatedAt,
    sourceSignalIds: [],
    budget,
    sections: [],
    markdown: bounded,
  };
}