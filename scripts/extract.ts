#!/usr/bin/env node
/**
 * CLI Entry Point — PRD §7
 * Reads config.yaml, runs full extraction pipeline (Layer 1-3), generates output files.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { NoiseFilter } from '../src/utils/noise-filter.js';
import { runLayer1 } from '../src/extractors/layer1.js';
import { runLayer2 } from '../src/extractors/layer2.js';
import { runLayer3, type Decision, type PainPoint, type Preference } from '../src/extractors/layer3.js';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

interface Config {
  sources?: {
    opencode?: { enabled?: boolean; db_path?: string };
    claude_code?: { enabled?: boolean; base_dir?: string };
  };
  source_labels?: Record<string, string>;
  noise_filter?: {
    exclude_projects?: string[];
    include_projects?: string[];
    noise_project_human_threshold?: number;
  };
  layer3?: {
    enabled?: boolean;
    min_score?: number;
    max_sessions?: number;
    api_key?: string;
    api_base_url?: string;
    model?: string;
    consolidation_model?: string;
  };
  output_dir?: string;
}

interface LastExtraction {
  last_run: string;
  sources: Record<string, { last_session_time: number }>;
  layer3: {
    processed_sessions: string[];
    failed_sessions: string[];
    decisions?: Decision[];
    pain_points?: PainPoint[];
    preferences?: Preference[];
  };
  stats: {
    sessions_processed: Record<string, number> & { total?: number };
    decisions_extracted: number;
    todos_found: number;
  };
}

function loadConfig(): Config {
  const candidates = ['config.yaml', 'config.yml'];
  for (const name of candidates) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      return parseYaml(raw) as Config;
    }
  }
  console.log('No config.yaml found, using defaults.');
  return {};
}

function loadLastExtraction(outputDir: string): LastExtraction | null {
  const p = path.join(outputDir, '.last-extraction.json');
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

function saveLastExtraction(outputDir: string, data: LastExtraction): void {
  fs.writeFileSync(
    path.join(outputDir, '.last-extraction.json'),
    JSON.stringify(data, null, 2),
  );
}

function readFileIfExists(filePath: string): string | undefined {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return undefined;
}

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log('session-memory extract');
  console.log('=====================\n');

  // Step 1: Load config
  const config = loadConfig();
  const outputDir = expandHome(config.output_dir ?? '~/.local/share/session-memory');
  fs.mkdirSync(outputDir, { recursive: true });

  // Step 2: Initialize adapters
  const sourceLabels = config.source_labels ?? { opencode: 'OC', claude_code: 'CC' };
  const normalizedLabels: Record<string, string> = {};
  for (const [key, val] of Object.entries(sourceLabels)) {
    normalizedLabels[key.replace(/_/g, '-')] = val;
  }

  const registry = new AdapterRegistry(normalizedLabels);

  const ocConfig = config.sources?.opencode;
  if (ocConfig?.enabled !== false) {
    registry.register(new OpenCodeAdapter(ocConfig?.db_path));
  }

  const ccConfig = config.sources?.claude_code;
  if (ccConfig?.enabled !== false) {
    registry.register(new ClaudeCodeAdapter(ccConfig?.base_dir));
  }

  console.log('Detecting data sources...');
  await registry.initialize();

  const activeAdapters = registry.getActiveAdapters();
  if (activeAdapters.length === 0) {
    console.log('No data sources detected. Nothing to extract.');
    return;
  }
  console.log(`Active sources: ${activeAdapters.map(a => a.name).join(', ')}\n`);

  // Step 3: Load last extraction metadata
  const lastExtraction = loadLastExtraction(outputDir);
  const since: Record<string, number> = {};
  if (lastExtraction) {
    for (const [source, data] of Object.entries(lastExtraction.sources)) {
      since[source] = data.last_session_time;
    }
    console.log(`Incremental mode: last run ${lastExtraction.last_run}`);
  } else {
    console.log('Full extraction mode (first run)');
  }
  console.log('');

  // Step 4: Noise detection
  const noiseFilter = new NoiseFilter(config.noise_filter);
  const mergedProjects = registry.getAllProjects();
  console.log(`Found ${mergedProjects.length} projects across sources.`);
  console.log('Running noise detection...');
  const noiseReport = await noiseFilter.detect(registry, mergedProjects);

  if (noiseReport.auto_detected_noise_projects.length > 0) {
    console.log(`  Noise: ${noiseReport.auto_detected_noise_projects.map(p => p.project).join(', ')}`);
  }
  console.log(`  Filtered: ${noiseReport.sessions_filtered.total} sessions | Retained: ${noiseReport.sessions_retained.total} sessions\n`);

  fs.writeFileSync(
    path.join(outputDir, '.noise-report.json'),
    JSON.stringify(noiseReport, null, 2),
  );

  // ============================================================
  // Layer 1: Structured extraction
  // ============================================================
  console.log('Layer 1: Structured extraction...');

  const existingTimeline = readFileIfExists(path.join(outputDir, 'project-timeline.md'));
  const existingOpenThreads = readFileIfExists(path.join(outputDir, 'open-threads.md'));

  const layer1Result = await runLayer1(
    registry, noiseFilter, mergedProjects, since,
    existingTimeline, existingOpenThreads,
  );

  fs.writeFileSync(path.join(outputDir, 'project-timeline.md'), layer1Result.timelineContent);
  fs.writeFileSync(path.join(outputDir, 'open-threads.md'), layer1Result.openThreadsContent);
  console.log('  Written: project-timeline.md, open-threads.md');

  // Count stats
  let totalSessionsProcessed = 0;
  const sessionsPerSource: Record<string, number> = {};
  for (const sessions of layer1Result.sessionsByProject.values()) {
    for (const s of sessions) {
      sessionsPerSource[s.source] = (sessionsPerSource[s.source] ?? 0) + 1;
      totalSessionsProcessed++;
    }
  }

  // Save Layer 1 checkpoint
  const newLastExtraction: LastExtraction = {
    last_run: new Date().toISOString(),
    sources: {},
    layer3: lastExtraction?.layer3 ?? { processed_sessions: [], failed_sessions: [] },
    stats: {
      sessions_processed: { ...sessionsPerSource, total: totalSessionsProcessed },
      decisions_extracted: lastExtraction?.stats.decisions_extracted ?? 0,
      todos_found: (await registry.getAllTodos()).length,
    },
  };
  for (const [source, time] of Object.entries(layer1Result.latestSessionTime)) {
    const prevTime = lastExtraction?.sources[source]?.last_session_time ?? 0;
    newLastExtraction.sources[source] = { last_session_time: Math.max(prevTime, time) };
  }
  if (lastExtraction) {
    for (const [source, data] of Object.entries(lastExtraction.sources)) {
      if (!newLastExtraction.sources[source]) newLastExtraction.sources[source] = data;
    }
  }
  saveLastExtraction(outputDir, newLastExtraction);

  // ============================================================
  // Layer 2: Semi-structured extraction
  // ============================================================
  console.log('\nLayer 2: Semi-structured extraction...');

  const sourceSummary = await registry.getSourceSummary();
  const existingWorkPatterns = readFileIfExists(path.join(outputDir, 'work-patterns.md'));
  const existingTechPrefs = readFileIfExists(path.join(outputDir, 'tech-preferences.md'));

  const layer2Result = await runLayer2(
    registry, noiseFilter, mergedProjects, sourceSummary,
    existingWorkPatterns, existingTechPrefs,
  );

  fs.writeFileSync(path.join(outputDir, 'work-patterns.md'), layer2Result.workPatternsContent);
  fs.writeFileSync(path.join(outputDir, 'tech-preferences.md'), layer2Result.techPreferencesContent);
  console.log('  Written: work-patterns.md, tech-preferences.md');
  console.log(`  Task types: ${layer2Result.taskTypes.length} categories`);
  console.log(`  Tech mentions: ${layer2Result.techMentions.length} technologies detected`);

  // ============================================================
  // Layer 3: Deep extraction (AI batch summary)
  // ============================================================
  const layer3Enabled = config.layer3?.enabled !== false;

  if (layer3Enabled) {
    console.log('\nLayer 3: Deep extraction (AI)...');

    const layer3Config = {
      min_score: config.layer3?.min_score ?? 3,
      max_sessions: config.layer3?.max_sessions ?? 500,
      api_key: config.layer3?.api_key,
      api_base_url: config.layer3?.api_base_url,
      model: config.layer3?.model,
      consolidation_model: config.layer3?.consolidation_model,
    };

    const existingDecisions = readFileIfExists(path.join(outputDir, 'decisions.md'));
    const existingPainPoints = readFileIfExists(path.join(outputDir, 'pain-points.md'));
    const existingWorkProfile = readFileIfExists(path.join(outputDir, 'work-profile.md'));

    const layer3Result = await runLayer3(
      registry, noiseFilter, mergedProjects, layer3Config,
      lastExtraction?.layer3?.processed_sessions ?? [],
      sourceSummary,
      existingDecisions, existingPainPoints, existingWorkProfile,
      lastExtraction?.layer3?.decisions,
      lastExtraction?.layer3?.pain_points,
      lastExtraction?.layer3?.preferences,
    );

    fs.writeFileSync(path.join(outputDir, 'decisions.md'), layer3Result.decisionsContent);
    fs.writeFileSync(path.join(outputDir, 'pain-points.md'), layer3Result.painPointsContent);
    fs.writeFileSync(path.join(outputDir, 'work-profile.md'), layer3Result.workProfileContent);
    console.log('  Written: decisions.md, pain-points.md, work-profile.md');
    console.log(`  Decisions extracted: ${layer3Result.decisions.length}`);
    console.log(`  Pain points extracted: ${layer3Result.painPoints.length}`);
    console.log(`  Sessions processed by AI: ${layer3Result.processedSessionIds.length}`);

    // Update metadata
    const allProcessed = [
      ...(lastExtraction?.layer3?.processed_sessions ?? []),
      ...layer3Result.processedSessionIds,
    ];
    newLastExtraction.layer3 = {
      processed_sessions: [...new Set(allProcessed)],
      failed_sessions: layer3Result.failedSessionIds,
      decisions: layer3Result.decisions,
      pain_points: layer3Result.painPoints,
      preferences: layer3Result.preferences,
    };
    newLastExtraction.stats.decisions_extracted = layer3Result.decisions.length;
    saveLastExtraction(outputDir, newLastExtraction);
  } else {
    console.log('\nLayer 3: Skipped (disabled in config or no API key)');
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Done in ${elapsed}s. Output: ${outputDir}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
