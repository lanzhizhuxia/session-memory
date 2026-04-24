import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { callAI, parseJSON } from '../../utils/ai-client.js';

export interface PolishConfig {
  enabled: boolean;
  model: string;
  api_key?: string;
  api_base_url?: string;
  max_chars_per_call: number;
  cache_version: string;
  cache_dir: string;
}

export interface PolishSectionInput {
  sectionId: string;
  title: string;
  draftMarkdown: string;
}

interface PolishSectionOutput {
  sectionId: string;
  markdown: string;
}

interface CacheEntry {
  markdown: string;
  model: string;
  cacheVersion: string;
  createdAt: string;
}

type PolishCache = Record<string, CacheEntry>;

interface PolishResponse {
  sections?: PolishSectionOutput[];
}

const CACHE_FILE = 'view-polish-cache.json';

function getCachePath(config: PolishConfig): string {
  return path.join(config.cache_dir, CACHE_FILE);
}

function loadCache(config: PolishConfig): PolishCache {
  const cachePath = getCachePath(config);
  try {
    if (!fs.existsSync(cachePath)) return {};
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PolishCache : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  View polish cache load failed: ${message}`);
    return {};
  }
}

function saveCache(config: PolishConfig, cache: PolishCache): void {
  try {
    fs.mkdirSync(config.cache_dir, { recursive: true });
    fs.writeFileSync(getCachePath(config), JSON.stringify(cache, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  View polish cache save failed: ${message}`);
  }
}

function computeCacheKey(viewId: string, section: PolishSectionInput, config: PolishConfig): string {
  return createHash('sha256')
    .update(viewId)
    .update('\0')
    .update(section.sectionId)
    .update('\0')
    .update(config.cache_version)
    .update('\0')
    .update(config.model)
    .update('\0')
    .update(section.draftMarkdown)
    .digest('hex');
}

function chunkSections(sections: PolishSectionInput[], viewTitle: string, maxChars: number): PolishSectionInput[][] {
  const batches: PolishSectionInput[][] = [];
  let currentBatch: PolishSectionInput[] = [];
  let currentChars = JSON.stringify({ viewTitle, sections: [] }).length;

  for (const section of sections) {
    const sectionChars = JSON.stringify(section).length;
    const exceedsCurrent = currentBatch.length > 0 && currentChars + sectionChars > maxChars;
    if (exceedsCurrent) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = JSON.stringify({ viewTitle, sections: [] }).length;
    }

    currentBatch.push(section);
    currentChars += sectionChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

export async function polishSections(
  viewId: string,
  viewTitle: string,
  sections: PolishSectionInput[],
  polishPrompt: string,
  config: PolishConfig,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (!config.enabled || sections.length === 0) {
    for (const section of sections) {
      result.set(section.sectionId, section.draftMarkdown);
    }
    return result;
  }

  const cache = loadCache(config);
  const uncached: Array<{ section: PolishSectionInput; cacheKey: string }> = [];
  let cachedCount = 0;
  let polishedCount = 0;
  let failedCount = 0;

  for (const section of sections) {
    const cacheKey = computeCacheKey(viewId, section, config);
    const cached = cache[cacheKey];
    if (cached?.markdown) {
      result.set(section.sectionId, cached.markdown);
      cachedCount++;
    } else {
      uncached.push({ section, cacheKey });
    }
  }

  if (uncached.length === 0) {
    console.log(`  View polish: 0 sections polished, ${cachedCount} cached, 0 failed`);
    return result;
  }

  const batches = chunkSections(uncached.map((entry) => entry.section), viewTitle, config.max_chars_per_call);
  const cacheKeyBySectionId = new Map(uncached.map((entry) => [entry.section.sectionId, entry.cacheKey]));

  for (const batch of batches) {
    const responseText = await callAI(
      polishPrompt,
      JSON.stringify({ viewTitle, sections: batch }),
      config,
      config.model,
      4096,
    );

    const parsed = parseJSON<PolishResponse>(responseText);
    const polishedById = new Map<string, string>();
    for (const item of parsed?.sections ?? []) {
      if (item?.sectionId && typeof item.markdown === 'string' && item.markdown.trim().length > 0) {
        polishedById.set(item.sectionId, item.markdown);
      }
    }

    for (const section of batch) {
      const polished = polishedById.get(section.sectionId);
      if (polished != null) {
        result.set(section.sectionId, polished);
        const cacheKey = cacheKeyBySectionId.get(section.sectionId);
        if (cacheKey) {
          cache[cacheKey] = {
            markdown: polished,
            model: config.model,
            cacheVersion: config.cache_version,
            createdAt: new Date().toISOString(),
          };
        }
        polishedCount++;
      } else {
        result.set(section.sectionId, section.draftMarkdown);
        failedCount++;
      }
    }

    saveCache(config, cache);
  }

  console.log(`  View polish: ${polishedCount} sections polished, ${cachedCount} cached, ${failedCount} failed`);
  return result;
}
