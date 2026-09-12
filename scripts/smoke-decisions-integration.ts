import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compileDecisionsArchiveView,
  DECISIONS_ARCHIVE_BUDGET,
} from '../src/canonical/views/decisions.js';
import type { CanonicalSignal, PublishedView } from '../src/canonical/types.js';

function ts(yyyyMmDd: string): number {
  return Date.parse(`${yyyyMmDd}T12:00:00Z`);
}

function mkDecision(id: string, dateStr: string): CanonicalSignal {
  const lastSeen = ts(dateStr);
  return {
    id,
    kind: 'decision',
    canonicalKey: `key-${id}`,
    fingerprintSet: [`fp-${id}`],
    status: 'active',
    projectIds: ['aibuddy'],
    projectNames: ['aibuddy'],
    evidenceIds: [],
    sourceLabels: ['OC'],
    trustScore: 3,
    confidence: 0.8,
    supportCount: 1,
    firstSeenAt: lastSeen,
    lastSeenAt: lastSeen,
    summary: 'd',
    payload: {
      topic: `topic ${id}`,
      decision: `decision ${id}`,
      rationale: `rationale ${id}`,
      alternatives: [],
      scope: 'project',
    },
  } as CanonicalSignal;
}

async function main() {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-integration-'));
  console.log(`\nintegration sandbox: ${sandboxDir}`);

  try {
    const sigs: CanonicalSignal[] = [];
    sigs.push(mkDecision('m1', '2026-05-10'));
    sigs.push(mkDecision('m2', '2026-05-15'));
    sigs.push(mkDecision('m3', '2026-04-20'));
    sigs.push(mkDecision('m4', '2025-08-15'));
    sigs.push(mkDecision('m5', '2025-03-10'));
    sigs.push(mkDecision('m6', '2024-11-20'));

    const result = await compileDecisionsArchiveView(
      sigs,
      DECISIONS_ARCHIVE_BUDGET,
      'opencode(6)',
    );

    const mainPath = path.join(sandboxDir, '决策日志.md');
    fs.writeFileSync(mainPath, result.view.markdown);

    const archivePath = result.view.archiveFile;
    assert.ok(archivePath != null);
    if (result.archiveMarkdown.length > 0) {
      const archiveAbs = path.join(sandboxDir, archivePath!);
      fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
      fs.writeFileSync(archiveAbs, result.archiveMarkdown);
    }

    const stateDir = path.join(sandboxDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const manifest: PublishedView[] = [result.view];
    fs.writeFileSync(
      path.join(stateDir, 'publish-manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    console.log('\nverifying...');

    assert.ok(fs.existsSync(mainPath));
    const mainContent = fs.readFileSync(mainPath, 'utf8');
    assert.ok(mainContent.includes('# 决策日志'));
    assert.ok(mainContent.includes('## 历史索引'));
    assert.ok(mainContent.includes('<!-- modality: event -->'));
    console.log('  ✓ main file has header + history index + modality marker');

    const archiveAbs = path.join(sandboxDir, archivePath!);
    assert.ok(fs.existsSync(archiveAbs));
    const archiveContent = fs.readFileSync(archiveAbs, 'utf8');
    assert.ok(archiveContent.includes('m5'), 'archive should contain m5 (2025-03)');
    assert.ok(archiveContent.includes('m6'), 'archive should contain m6 (2024-11)');
    console.log('  ✓ archive file written and contains old signals (m5, m6)');

    assert.ok(mainContent.includes('m1'), 'main should contain m1');
    assert.ok(mainContent.includes('m2'), 'main should contain m2');
    assert.ok(mainContent.includes('m3'), 'main should contain m3');
    assert.ok(mainContent.includes('m4'), 'main should contain m4 (in 12-month window)');
    assert.ok(!mainContent.includes('decision m6'), 'main should NOT contain m6');
    assert.ok(!mainContent.includes('decision m5'), 'main should NOT contain m5');
    console.log('  ✓ main has signals within 12-month window; older not in main');

    const manifestPath = path.join(stateDir, 'publish-manifest.json');
    assert.ok(fs.existsSync(manifestPath));
    const loadedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PublishedView[];
    assert.equal(loadedManifest.length, 1);
    const loaded = loadedManifest[0];
    assert.equal(loaded.viewId, 'decisions');
    assert.equal(loaded.archiveFile, 'archive/决策日志-archive.md');
    assert.ok(loaded.archiveIndex != null);
    assert.ok(loaded.archiveIndex!.length >= 4);
    console.log('  ✓ publish-manifest.json round-trips with archiveFile + archiveIndex');

    const indexEntries = loaded.archiveIndex!;
    const archiveEntries = indexEntries.filter((e) => e.location === 'archive');
    const currentEntries = indexEntries.filter((e) => e.location === 'current');
    assert.ok(archiveEntries.length >= 2, `expected >=2 archive entries, got ${archiveEntries.length}`);
    assert.ok(currentEntries.length >= 2, `expected >=2 current entries, got ${currentEntries.length}`);
    console.log('  ✓ archiveIndex has both current and archive entries');

    const allIds = new Set(sigs.map((s) => s.id));
    const sourceIds = new Set(loaded.sourceSignalIds);
    for (const id of allIds) {
      assert.ok(sourceIds.has(id), `signal ${id} missing from sourceSignalIds`);
    }
    console.log('  ✓ no signal lost (all 6 in sourceSignalIds)');

    console.log('\nintegration test passed ✓');
    console.log(`(sandbox kept at ${sandboxDir} for inspection; main = 决策日志.md, archive = archive/...)`);
  } catch (err) {
    console.error('\nFAIL:', err);
    console.error(`sandbox at ${sandboxDir}`);
    process.exit(1);
  }
}

main();
