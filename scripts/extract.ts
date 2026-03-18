#!/usr/bin/env node
/**
 * CLI Entry Point — PRD §7
 * Reads config.yaml, runs full extraction pipeline, generates output files.
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
    min_score?: number;
    max_sessions?: number;
  };
  output_dir?: string;
}

interface LastExtraction {
  last_run: string;
  sources: Record<string, { last_session_time: number }>;
  layer3: {
    processed_sessions: string[];
    failed_sessions: string[];
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
  // No config file found, use defaults
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
  console.log('session-memory extract — Phase 0');
  console.log('================================\n');

  // Step 1: Load config
  const config = loadConfig();
  const outputDir = expandHome(config.output_dir ?? '~/.local/share/session-memory');

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Step 2: Initialize adapters
  const sourceLabels = config.source_labels ?? { opencode: 'OC', claude_code: 'CC' };
  // Normalize: claude_code label key should map to adapter name 'claude-code'
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
    console.log(`Incremental mode: found .last-extraction.json (last run: ${lastExtraction.last_run})`);
  } else {
    console.log('Full extraction mode (no .last-extraction.json found)');
  }
  console.log('');

  // Step 4: Run noise detection
  const noiseFilter = new NoiseFilter(config.noise_filter);
  const mergedProjects = registry.getAllProjects();
  console.log(`Found ${mergedProjects.length} projects across sources.`);

  console.log('Running noise detection...');
  const noiseReport = await noiseFilter.detect(registry, mergedProjects);

  if (noiseReport.auto_detected_noise_projects.length > 0) {
    console.log(`  Noise projects detected: ${noiseReport.auto_detected_noise_projects.map(p => p.project).join(', ')}`);
  }
  console.log(`  Sessions filtered: ${noiseReport.sessions_filtered.total}`);
  console.log(`  Sessions retained: ${noiseReport.sessions_retained.total}`);
  console.log('');

  // Save noise report
  fs.writeFileSync(
    path.join(outputDir, '.noise-report.json'),
    JSON.stringify(noiseReport, null, 2),
  );
  console.log(`Saved .noise-report.json`);

  // Step 5: Run Layer 1 extraction
  console.log('\nRunning Layer 1 extraction...');

  const existingTimeline = readFileIfExists(path.join(outputDir, 'project-timeline.md'));
  const existingOpenThreads = readFileIfExists(path.join(outputDir, 'open-threads.md'));

  const layer1Result = await runLayer1(
    registry,
    noiseFilter,
    mergedProjects,
    since,
    existingTimeline,
    existingOpenThreads,
  );

  // Write output files
  fs.writeFileSync(path.join(outputDir, 'project-timeline.md'), layer1Result.timelineContent);
  console.log('  Written: project-timeline.md');

  fs.writeFileSync(path.join(outputDir, 'open-threads.md'), layer1Result.openThreadsContent);
  console.log('  Written: open-threads.md');

  // Step 6: Count stats
  let totalSessionsProcessed = 0;
  const sessionsPerSource: Record<string, number> = {};
  for (const sessions of layer1Result.sessionsByProject.values()) {
    for (const s of sessions) {
      sessionsPerSource[s.source] = (sessionsPerSource[s.source] ?? 0) + 1;
      totalSessionsProcessed++;
    }
  }

  // Step 7: Update last extraction metadata
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

  // Update per-source last_session_time
  for (const [source, time] of Object.entries(layer1Result.latestSessionTime)) {
    const prevTime = lastExtraction?.sources[source]?.last_session_time ?? 0;
    newLastExtraction.sources[source] = {
      last_session_time: Math.max(prevTime, time),
    };
  }
  // Preserve sources that weren't updated this run
  if (lastExtraction) {
    for (const [source, data] of Object.entries(lastExtraction.sources)) {
      if (!newLastExtraction.sources[source]) {
        newLastExtraction.sources[source] = data;
      }
    }
  }

  saveLastExtraction(outputDir, newLastExtraction);
  console.log('  Written: .last-extraction.json');

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone! Processed ${totalSessionsProcessed} sessions in ${elapsed}s.`);
  console.log(`Output directory: ${outputDir}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
