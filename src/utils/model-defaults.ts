/**
 * Centralized model defaults for session-memory.
 * All hardcoded model names across the codebase import from here.
 * To change a default model, edit this file and rebuild.
 */
export const MODEL_DEFAULTS = {
  /** Layer 3: high-volume JSON extraction (decisions / pain points / preferences) */
  extraction: 'deepseek-v4-flash',

  /** Layer 3: low-volume consolidation & dedup (requires stronger reasoning) */
  consolidation: 'deepseek-v4-pro',

  /** Rare fallback for sessions exceeding long_context_threshold characters */
  longContext: 'deepseek-v4-pro',

  /** Layer 4: cached output polish (Chinese readability, tone, structure) */
  polish: 'deepseek-v4-pro',
} as const;