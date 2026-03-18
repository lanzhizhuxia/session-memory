/**
 * Noise Filter — PRD §3
 * 5 auto-detection rules based on NoiseSignals
 * 2-of-5 threshold, config manual override, session-level filtering
 */

import type { NoiseSignals, MergedProject } from '../adapters/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';

export interface NoiseFilterConfig {
  exclude_projects?: string[];
  include_projects?: string[];
  noise_project_human_threshold?: number; // user messages > N → human session
}

export interface NoiseReport {
  auto_detected_noise_projects: Array<{ project: string; path: string; sources: string[] }>;
  rules_triggered: Record<string, string[]>;
  manual_overrides: { excluded: string[]; included: string[] };
  sessions_filtered: Record<string, number> & { total: number };
  sessions_retained: Record<string, number> & { total: number };
  warnings?: string[];
}

type RuleName =
  | 'uniform_hour_distribution'
  | 'low_unique_first_message'
  | 'short_session_duration'
  | 'dominant_session_share'
  | 'low_user_participation';

/** Calculate variance of an array */
function variance(arr: number[]): number {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

export class NoiseFilter {
  private config: NoiseFilterConfig;
  private excludedPaths: Set<string> = new Set();
  private noiseProjectPaths: Set<string> = new Set();
  private retainedSessionIds: Set<string> = new Set();
  private filteredSessionCounts: Record<string, number> = {};
  private retainedSessionCounts: Record<string, number> = {};
  private rulesTriggered: Record<string, RuleName[]> = {};
  private report: NoiseReport | null = null;

  constructor(config: NoiseFilterConfig = {}) {
    this.config = config;
  }

  /**
   * Run noise detection on all merged projects.
   * Returns the set of excluded project paths.
   */
  async detect(
    registry: AdapterRegistry,
    mergedProjects: MergedProject[],
  ): Promise<NoiseReport> {
    this.excludedPaths.clear();
    this.noiseProjectPaths.clear();
    this.rulesTriggered = {};
    this.filteredSessionCounts = {};
    this.retainedSessionCounts = {};

    const autoDetected: NoiseReport['auto_detected_noise_projects'] = [];

    // Step 1: For each merged project, aggregate NoiseSignals across sources
    for (const mp of mergedProjects) {
      // Manual include override — skip noise detection
      if (this.config.include_projects?.includes(mp.name)) continue;

      // Manual exclude override — directly mark as noise
      if (this.config.exclude_projects?.includes(mp.name)) {
        this.excludedPaths.add(mp.path);
        continue;
      }

      // Aggregate signals across sources
      const allSignals: NoiseSignals[] = [];
      for (const ps of mp.sources) {
        try {
          const signals = await registry.getNoiseSignals(ps.source, ps.projectId);
          allSignals.push(signals);
        } catch {
          // Source unavailable, skip
        }
      }

      if (allSignals.length === 0) continue;

      // Merge signals across sources
      const merged = this.mergeSignals(allSignals, mp);
      const triggered = this.evaluateRules(merged);

      if (triggered.length >= 2) {
        this.noiseProjectPaths.add(mp.path);
        this.rulesTriggered[mp.name] = triggered;
        autoDetected.push({
          project: mp.name,
          path: mp.path,
          sources: mp.sources.map(s => s.source),
        });
      }
    }

    // Step 2: For noise projects, apply session-level filtering if threshold configured
    const threshold = this.config.noise_project_human_threshold;
    let totalFiltered = 0;
    let totalRetained = 0;

    for (const mp of mergedProjects) {
      const isNoise = this.noiseProjectPaths.has(mp.path) || this.excludedPaths.has(mp.path);
      const isManualInclude = this.config.include_projects?.includes(mp.name);

      const sessions = await registry.getSessions(mp);

      if (!isNoise || isManualInclude) {
        // Not noise — all sessions retained
        for (const s of sessions) {
          this.retainedSessionIds.add(s.id);
          this.retainedSessionCounts[s.source] = (this.retainedSessionCounts[s.source] ?? 0) + 1;
        }
        totalRetained += sessions.length;
        continue;
      }

      // Noise project — check session-level threshold
      if (threshold != null && threshold > 0) {
        for (const s of sessions) {
          const msgs = await registry.getMessages(s);
          const userMsgCount = msgs.filter(m => m.role === 'user').length;
          if (userMsgCount > threshold) {
            this.retainedSessionIds.add(s.id);
            this.retainedSessionCounts[s.source] = (this.retainedSessionCounts[s.source] ?? 0) + 1;
            totalRetained++;
          } else {
            this.filteredSessionCounts[s.source] = (this.filteredSessionCounts[s.source] ?? 0) + 1;
            totalFiltered++;
          }
        }
      } else {
        // No threshold — all sessions in noise project filtered
        for (const s of sessions) {
          this.filteredSessionCounts[s.source] = (this.filteredSessionCounts[s.source] ?? 0) + 1;
        }
        totalFiltered += sessions.length;
      }
    }

    this.report = {
      auto_detected_noise_projects: autoDetected,
      rules_triggered: this.rulesTriggered,
      manual_overrides: {
        excluded: this.config.exclude_projects ?? [],
        included: this.config.include_projects ?? [],
      },
      sessions_filtered: { ...this.filteredSessionCounts, total: totalFiltered },
      sessions_retained: { ...this.retainedSessionCounts, total: totalRetained },
    };

    return this.report;
  }

  private mergeSignals(signals: NoiseSignals[], mp: MergedProject): NoiseSignals {
    // Merge hour distributions
    const hourDistribution = new Array(24).fill(0);
    for (const s of signals) {
      for (let i = 0; i < 24; i++) {
        hourDistribution[i] += s.hourDistribution[i];
      }
    }

    // Weighted average for ratios
    // uniqueFirstMessageRatio — use minimum (most conservative)
    const uniqueFirstMessageRatio = Math.min(...signals.map(s => s.uniqueFirstMessageRatio));

    // medianSessionDurationMs — use minimum
    const medianSessionDurationMs = Math.min(...signals.map(s => s.medianSessionDurationMs));

    // sessionSharePercent — we need the total across all sources
    // This is approximate since each source computes it independently
    const sessionSharePercent = Math.max(...signals.map(s => s.sessionSharePercent));

    // userMessageRatio — use minimum
    const userMessageRatio = Math.min(...signals.map(s => s.userMessageRatio));

    return {
      projectId: mp.sources[0].projectId,
      hourDistribution,
      uniqueFirstMessageRatio,
      medianSessionDurationMs,
      sessionSharePercent,
      userMessageRatio,
    };
  }

  private evaluateRules(signals: NoiseSignals): RuleName[] {
    const triggered: RuleName[] = [];

    // Rule 1: Uniform hour distribution (variance < threshold)
    const hourVar = variance(signals.hourDistribution);
    const totalSessions = signals.hourDistribution.reduce((s, v) => s + v, 0);
    // Normalize variance by mean^2 (coefficient of variation squared)
    const mean = totalSessions / 24;
    const normalizedVar = mean > 0 ? hourVar / (mean * mean) : 0;
    if (normalizedVar < 0.5 && totalSessions > 100) {
      triggered.push('uniform_hour_distribution');
    }

    // Rule 2: Low unique first message ratio
    if (signals.uniqueFirstMessageRatio < 0.3) {
      triggered.push('low_unique_first_message');
    }

    // Rule 3: Short median session duration
    if (signals.medianSessionDurationMs < 60_000 && signals.medianSessionDurationMs > 0) {
      triggered.push('short_session_duration');
    }

    // Rule 4: Dominant session share
    if (signals.sessionSharePercent > 70) {
      triggered.push('dominant_session_share');
    }

    // Rule 5: Low user participation
    if (signals.userMessageRatio < 0.2) {
      triggered.push('low_user_participation');
    }

    return triggered;
  }

  /** Check if a project path is excluded (noise) */
  isProjectExcluded(path: string): boolean {
    return this.excludedPaths.has(path) || this.noiseProjectPaths.has(path);
  }

  /** Check if a specific session is retained (passed through noise filter) */
  isSessionRetained(sessionId: string): boolean {
    return this.retainedSessionIds.has(sessionId);
  }

  /** Check if a merged project is noise */
  isNoise(mp: MergedProject): boolean {
    if (this.config.include_projects?.includes(mp.name)) return false;
    if (this.config.exclude_projects?.includes(mp.name)) return true;
    return this.noiseProjectPaths.has(mp.path);
  }

  getReport(): NoiseReport | null {
    return this.report;
  }
}
