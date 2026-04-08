import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalSignal, EvidenceRecord, PublishedView } from './types.js';
import type { SignalCandidate, SignalKind } from './types.js';

export interface QuarantineRecord {
  candidate: SignalCandidate;
  reasonCodes: string[];
  createdAt: number;
}

interface StoreSnapshot {
  signals: CanonicalSignal[];
  evidence: EvidenceRecord[];
  quarantine: QuarantineRecord[];
  publishManifest: PublishedView[];
}

function backupCorruptFile(filePath: string): void {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, backupPath);
    console.warn(`Corrupted state file moved to ${backupPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to quarantine corrupted state file ${filePath}: ${message}`);
  }
}

function readJsonArrayFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }

    console.warn(`Expected array in ${filePath}; resetting state file.`);
    backupCorruptFile(filePath);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to parse ${filePath}; resetting state file: ${message}`);
    backupCorruptFile(filePath);
    return [];
  }
}

export class CanonicalStore {
  private readonly stateDir: string;
  private signals: CanonicalSignal[] = [];
  private evidence: EvidenceRecord[] = [];
  private quarantine: QuarantineRecord[] = [];
  private publishManifest: PublishedView[] = [];

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  load(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.signals = readJsonArrayFile<CanonicalSignal>(path.join(this.stateDir, 'signals.json'));
    this.evidence = readJsonArrayFile<EvidenceRecord>(path.join(this.stateDir, 'evidence.json'));
    this.quarantine = readJsonArrayFile<QuarantineRecord>(path.join(this.stateDir, 'quarantine.json'));
    this.publishManifest = readJsonArrayFile<PublishedView>(path.join(this.stateDir, 'publish-manifest.json'));
  }

  save(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const snapshot: StoreSnapshot = {
      signals: this.signals,
      evidence: this.evidence,
      quarantine: this.quarantine,
      publishManifest: this.publishManifest,
    };

    fs.writeFileSync(path.join(this.stateDir, 'signals.json'), JSON.stringify(snapshot.signals, null, 2));
    fs.writeFileSync(path.join(this.stateDir, 'evidence.json'), JSON.stringify(snapshot.evidence, null, 2));
    fs.writeFileSync(path.join(this.stateDir, 'quarantine.json'), JSON.stringify(snapshot.quarantine, null, 2));
    fs.writeFileSync(path.join(this.stateDir, 'publish-manifest.json'), JSON.stringify(snapshot.publishManifest, null, 2));
  }

  getSignals(kind?: SignalKind): CanonicalSignal[] {
    return kind == null
      ? [...this.signals]
      : this.signals.filter((signal) => signal.kind === kind);
  }

  addSignals(signals: CanonicalSignal[]): void {
    const byId = new Map<string, CanonicalSignal>(this.signals.map((signal) => [signal.id, signal]));
    for (const signal of signals) {
      byId.set(signal.id, signal);
    }
    this.signals = [...byId.values()];
  }

  replaceSignals(kind: SignalKind, signals: CanonicalSignal[]): void {
    this.signals = [...this.signals.filter((signal) => signal.kind !== kind), ...signals];
  }

  getEvidence(): EvidenceRecord[] {
    return [...this.evidence];
  }

  addEvidence(evidence: EvidenceRecord[]): void {
    const byId = new Map<string, EvidenceRecord>(this.evidence.map((entry) => [entry.id, entry]));
    for (const entry of evidence) {
      byId.set(entry.id, entry);
    }
    this.evidence = [...byId.values()];
  }

  getQuarantine(): QuarantineRecord[] {
    return [...this.quarantine];
  }

  addQuarantine(records: QuarantineRecord[]): void {
    const byCandidateId = new Map<string, QuarantineRecord>(
      this.quarantine.map((record) => [record.candidate.id, record]),
    );

    for (const record of records) {
      byCandidateId.set(record.candidate.id, record);
    }

    this.quarantine = [...byCandidateId.values()];
  }

  getPublishManifest(): PublishedView[] {
    return [...this.publishManifest];
  }

  upsertPublishedView(view: PublishedView): void {
    const next = this.publishManifest.filter((entry) => entry.viewId !== view.viewId);
    next.push(view);
    this.publishManifest = next;
  }
}
