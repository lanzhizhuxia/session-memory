/**
 * OpenCode Adapter — PRD §2.2
 * better-sqlite3 read-only connection to opencode.db
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SourceAdapter } from './interface.js';
import type { Project, Session, Message, Todo, NoiseSignals } from './types.js';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export class OpenCodeAdapter implements SourceAdapter {
  readonly name = 'opencode';
  private dbPath: string;
  private db: Database.Database | null = null;
  private sessionCache: Map<string, Session> = new Map();
  private projectCache: Map<string, Project> = new Map();
  private cacheReady = false;

  constructor(dbPath?: string) {
    this.dbPath = expandHome(dbPath ?? '~/.local/share/opencode/opencode.db');
  }

  async detect(): Promise<boolean> {
    return fs.existsSync(this.dbPath);
  }

  private getDb(): Database.Database {
    if (!this.db) {
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      this.db.pragma('journal_mode = WAL');
    }
    return this.db;
  }

  private ensureCache(): void {
    if (this.cacheReady) return;
    const db = this.getDb();

    // Cache projects
    const projects = db.prepare(`
      SELECT id, worktree, name, time_created, time_updated FROM project
    `).all() as Array<{ id: string; worktree: string; name: string | null; time_created: number; time_updated: number }>;

    for (const p of projects) {
      this.projectCache.set(p.id, {
        id: p.id,
        name: p.name ?? path.basename(p.worktree),
        path: p.worktree,
        source: this.name,
        timeCreated: p.time_created,
      });
    }

    // Cache sessions
    const sessions = db.prepare(`
      SELECT id, project_id, parent_id, title,
             summary_additions, summary_deletions, summary_files,
             time_created, time_archived
      FROM session
    `).all() as Array<{
      id: string; project_id: string; parent_id: string | null; title: string | null;
      summary_additions: number | null; summary_deletions: number | null; summary_files: number | null;
      time_created: number; time_archived: number | null;
    }>;

    for (const s of sessions) {
      const session: Session = {
        id: s.id,
        projectId: s.project_id,
        source: this.name,
        title: s.title ?? undefined,
        parentId: s.parent_id ?? undefined,
        messageCount: 0, // filled lazily
        timeCreated: s.time_created,
        timeEnd: s.time_archived ?? undefined,
      };
      if (s.summary_additions != null || s.summary_deletions != null || s.summary_files != null) {
        session.codeChurn = {
          additions: s.summary_additions ?? 0,
          deletions: s.summary_deletions ?? 0,
          files: s.summary_files ?? 0,
        };
      }
      this.sessionCache.set(s.id, session);
    }

    this.cacheReady = true;
  }

  async getProjects(): Promise<Project[]> {
    this.ensureCache();
    return Array.from(this.projectCache.values());
  }

  async getSessions(projectId: string, since?: number): Promise<Session[]> {
    this.ensureCache();
    const db = this.getDb();

    let query = `
      SELECT s.id, s.project_id, s.parent_id, s.title,
             s.summary_additions, s.summary_deletions, s.summary_files,
             s.time_created, s.time_archived,
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as message_count
      FROM session s
      WHERE s.project_id = ?
    `;
    const params: (string | number)[] = [projectId];

    if (since != null) {
      query += ` AND s.time_created > ?`;
      params.push(since);
    }

    query += ` ORDER BY s.time_created ASC`;

    const rows = db.prepare(query).all(...params) as Array<{
      id: string; project_id: string; parent_id: string | null; title: string | null;
      summary_additions: number | null; summary_deletions: number | null; summary_files: number | null;
      time_created: number; time_archived: number | null; message_count: number;
    }>;

    return rows.map(s => {
      const session: Session = {
        id: s.id,
        projectId: s.project_id,
        source: this.name,
        title: s.title ?? undefined,
        parentId: s.parent_id ?? undefined,
        messageCount: s.message_count,
        timeCreated: s.time_created,
        timeEnd: s.time_archived ?? undefined,
      };
      if (s.summary_additions != null || s.summary_deletions != null || s.summary_files != null) {
        session.codeChurn = {
          additions: s.summary_additions ?? 0,
          deletions: s.summary_deletions ?? 0,
          files: s.summary_files ?? 0,
        };
      }
      // Update cache
      this.sessionCache.set(s.id, session);
      return session;
    });
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const db = this.getDb();

    // Messages are in message + part tables. Text content is in part.data.
    const rows = db.prepare(`
      SELECT m.id, m.session_id, m.data as message_data, m.time_created,
             p.data as part_data
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.time_created ASC, p.time_created ASC
    `).all(sessionId) as Array<{
      id: string; session_id: string; message_data: string;
      time_created: number; part_data: string | null;
    }>;

    // Group parts by message
    const messageMap = new Map<string, { id: string; sessionId: string; role: 'user' | 'assistant'; parts: string[]; timeCreated: number }>();

    for (const row of rows) {
      if (!messageMap.has(row.id)) {
        let role: 'user' | 'assistant' = 'user';
        try {
          const data = JSON.parse(row.message_data);
          role = data.role === 'assistant' ? 'assistant' : 'user';
        } catch {}
        messageMap.set(row.id, {
          id: row.id,
          sessionId: row.session_id,
          role,
          parts: [],
          timeCreated: row.time_created,
        });
      }

      if (row.part_data) {
        try {
          const partData = JSON.parse(row.part_data);
          // Extract text content from part data
          if (typeof partData === 'string') {
            messageMap.get(row.id)!.parts.push(partData);
          } else if (partData.type === 'text' && partData.text) {
            messageMap.get(row.id)!.parts.push(partData.text);
          } else if (partData.text) {
            messageMap.get(row.id)!.parts.push(partData.text);
          }
          // Skip tool_use / tool_result parts
        } catch {}
      }
    }

    return Array.from(messageMap.values()).map(m => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role,
      content: m.parts.join('\n'),
      timeCreated: m.timeCreated,
    }));
  }

  async getTodos(): Promise<Todo[]> {
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT t.session_id, t.content, t.status, t.priority,
             s.time_created as session_time_created
      FROM todo t
      LEFT JOIN session s ON t.session_id = s.id
      WHERE t.status IN ('pending', 'in_progress')
    `).all() as Array<{
      session_id: string; content: string; status: string;
      priority: string | null; session_time_created: number | null;
    }>;

    return rows.map(t => ({
      sessionId: t.session_id,
      content: t.content,
      status: t.status as Todo['status'],
      priority: t.priority ?? undefined,
      source: this.name,
      timeCreated: t.session_time_created ?? undefined,
    }));
  }

  async getNoiseSignals(projectId: string): Promise<NoiseSignals> {
    const db = this.getDb();

    // Total session count for this source
    const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM session`).get() as { cnt: number };
    const totalSessions = totalRow.cnt;

    // Sessions for this project
    const sessions = db.prepare(`
      SELECT s.id, s.time_created, s.time_archived
      FROM session s
      WHERE s.project_id = ?
    `).all(projectId) as Array<{ id: string; time_created: number; time_archived: number | null }>;

    const projectSessionCount = sessions.length;

    // Hour distribution (24 slots)
    const hourDistribution = new Array(24).fill(0);
    for (const s of sessions) {
      const hour = new Date(s.time_created).getHours();
      hourDistribution[hour]++;
    }

    // Unique first message ratio
    const firstMessages: string[] = [];
    for (const s of sessions) {
      const firstMsg = db.prepare(`
        SELECT p.data as part_data FROM message m
        JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY m.time_created ASC, p.time_created ASC
        LIMIT 1
      `).get(s.id) as { part_data: string } | undefined;

      if (firstMsg) {
        try {
          const d = JSON.parse(firstMsg.part_data);
          const text = typeof d === 'string' ? d : (d.text ?? '');
          firstMessages.push(text.trim().slice(0, 200));
        } catch {
          firstMessages.push('');
        }
      }
    }
    const uniqueFirstMessages = new Set(firstMessages.filter(m => m.length > 0));
    const uniqueFirstMessageRatio = firstMessages.length > 0
      ? uniqueFirstMessages.size / firstMessages.length
      : 1;

    // Median session duration
    const durations = sessions
      .filter(s => s.time_archived != null)
      .map(s => s.time_archived! - s.time_created)
      .filter(d => d > 0)
      .sort((a, b) => a - b);
    const medianSessionDurationMs = durations.length > 0
      ? durations[Math.floor(durations.length / 2)]
      : 0;

    // Session share percent
    const sessionSharePercent = totalSessions > 0
      ? (projectSessionCount / totalSessions) * 100
      : 0;

    // User message ratio
    const msgCounts = db.prepare(`
      SELECT m.data FROM message m
      WHERE m.session_id IN (SELECT id FROM session WHERE project_id = ?)
    `).all(projectId) as Array<{ data: string }>;

    let userMsgCount = 0;
    let totalMsgCount = msgCounts.length;
    for (const m of msgCounts) {
      try {
        const d = JSON.parse(m.data);
        if (d.role === 'user') userMsgCount++;
      } catch {}
    }
    const userMessageRatio = totalMsgCount > 0 ? userMsgCount / totalMsgCount : 0.5;

    return {
      projectId,
      hourDistribution,
      uniqueFirstMessageRatio,
      medianSessionDurationMs,
      sessionSharePercent,
      userMessageRatio,
    };
  }

  /** Look up a cached session by id */
  getSessionById(sessionId: string): Session | undefined {
    this.ensureCache();
    return this.sessionCache.get(sessionId);
  }

  /** Look up a cached project by id */
  getProjectById(projectId: string): Project | undefined {
    this.ensureCache();
    return this.projectCache.get(projectId);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
