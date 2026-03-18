/**
 * Claude Code Adapter — PRD §2.3
 * Glob + JSONL stream parsing from ~/.claude/projects/
 * sessions-index.json is unreliable, must fallback to JSONL scan
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { SourceAdapter } from './interface.js';
import type { Project, Session, Message, Todo, NoiseSignals } from './types.js';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

/** Decode Claude Code directory name to absolute path: -Users-you-project → /Users/you/project */
function decodeDirName(dirName: string): string {
  // Claude Code encodes paths: / → -
  // The dir name starts with -, representing the leading /
  return dirName.replace(/-/g, '/');
}

/** Extract project name from absolute path */
function projectNameFromPath(absPath: string): string {
  const name = path.basename(absPath);
  return name || '(global)';
}

interface JSONLEvent {
  type?: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }>;
  timestamp?: string;
  sessionId?: string;
  parentSessionId?: string | null;
  project?: string;
  durationMs?: number;
  tokenCount?: number;
  cost?: number;
  toolUseId?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
    model?: string;
  };
  uuid?: string;
  cwd?: string;
}

interface SessionIndex {
  id: string;
  summary?: string;
  [key: string]: unknown;
}

export class ClaudeCodeAdapter implements SourceAdapter {
  readonly name = 'claude-code';
  private baseDir: string;
  private projectsDir: string;
  private todosDir: string;
  private sessionCache: Map<string, Session> = new Map();
  private projectCache: Map<string, Project> = new Map();
  private cacheReady = false;
  // Map session ID → JSONL file path
  private sessionFileMap: Map<string, string> = new Map();
  // Map session ID → index summary (may be stale)
  private indexSummaries: Map<string, string> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = expandHome(baseDir ?? '~/.claude');
    this.projectsDir = path.join(this.baseDir, 'projects');
    this.todosDir = path.join(this.baseDir, 'todos');
  }

  async detect(): Promise<boolean> {
    return fs.existsSync(this.projectsDir);
  }

  private async ensureCache(): Promise<void> {
    if (this.cacheReady) return;

    if (!fs.existsSync(this.projectsDir)) return;

    const projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of projectDirs) {
      const dirPath = path.join(this.projectsDir, dir.name);
      const absProjectPath = decodeDirName(dir.name);
      const projectId = `cc:${dir.name}`;

      this.projectCache.set(projectId, {
        id: projectId,
        name: projectNameFromPath(absProjectPath),
        path: absProjectPath,
        source: this.name,
        timeCreated: 0, // will be set from earliest session
      });

      // Try to load sessions-index.json (unreliable, just for summary fallback)
      const indexPath = path.join(dirPath, 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          if (Array.isArray(indexData)) {
            for (const entry of indexData as SessionIndex[]) {
              if (entry.id && entry.summary) {
                this.indexSummaries.set(entry.id, entry.summary);
              }
            }
          }
        } catch {
          // Index unreliable, ignore
        }
      }

      // Scan JSONL files
      const jsonlFiles = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(dirPath, f));

      for (const jsonlFile of jsonlFiles) {
        const sessionId = path.basename(jsonlFile, '.jsonl');
        this.sessionFileMap.set(sessionId, jsonlFile);

        // Quick scan for session metadata (first and last lines)
        const session = await this.quickScanSession(sessionId, jsonlFile, projectId);
        if (session) {
          this.sessionCache.set(sessionId, session);
          // Update project timeCreated from earliest session
          const proj = this.projectCache.get(projectId)!;
          if (proj.timeCreated === 0 || session.timeCreated < proj.timeCreated) {
            proj.timeCreated = session.timeCreated;
          }
        }
      }
    }

    this.cacheReady = true;
  }

  private async quickScanSession(sessionId: string, filePath: string, projectId: string): Promise<Session | null> {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) return null;

      let firstTimestamp: number | null = null;
      let lastTimestamp: number | null = null;
      let messageCount = 0;
      let firstUserMsg: string | null = null;
      let title: string | undefined;
      let sessionEndDuration: number | undefined;

      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as JSONLEvent;
          const ts = event.timestamp ? new Date(event.timestamp).getTime() : null;

          if (ts != null) {
            if (firstTimestamp === null) firstTimestamp = ts;
            lastTimestamp = ts;
          }

          if (event.type === 'summary') {
            // Some newer Claude Code versions put summary in a specific event
            title = typeof event.content === 'string' ? event.content : undefined;
          }

          // Count messages (both user and assistant)
          if (event.type === 'human' || event.type === 'user') {
            messageCount++;
            if (firstUserMsg === null) {
              firstUserMsg = typeof event.content === 'string'
                ? event.content
                : (event.message?.content
                  ? (typeof event.message.content === 'string'
                    ? event.message.content
                    : event.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))
                  : null);
            }
          } else if (event.type === 'assistant') {
            messageCount++;
          }

          if (event.type === 'session_end' && event.durationMs) {
            sessionEndDuration = event.durationMs;
          }
        } catch {
          // Corrupted line, skip per PRD §8.5
        }
      }

      if (firstTimestamp === null) {
        // Fallback to file mtime
        firstTimestamp = stat.mtimeMs;
      }

      // Title fallback chain: index summary → first user message truncated → untitled
      if (!title) {
        title = this.indexSummaries.get(sessionId);
      }
      if (!title && firstUserMsg) {
        title = firstUserMsg.slice(0, 80).replace(/\n/g, ' ');
        if (firstUserMsg.length > 80) title += '...';
      }
      if (!title) {
        title = '(untitled session)';
      }

      // Duration / timeEnd
      let timeEnd: number | undefined;
      if (sessionEndDuration != null && firstTimestamp != null) {
        timeEnd = firstTimestamp + sessionEndDuration;
      } else if (lastTimestamp != null && lastTimestamp !== firstTimestamp) {
        timeEnd = lastTimestamp;
      }

      return {
        id: sessionId,
        projectId,
        source: this.name,
        title,
        messageCount,
        timeCreated: firstTimestamp,
        timeEnd,
      };
    } catch {
      return null;
    }
  }

  async getProjects(): Promise<Project[]> {
    await this.ensureCache();
    return Array.from(this.projectCache.values());
  }

  async getSessions(projectId: string, since?: number): Promise<Session[]> {
    await this.ensureCache();
    const sessions = Array.from(this.sessionCache.values())
      .filter(s => s.projectId === projectId);

    if (since != null) {
      return sessions.filter(s => s.timeCreated > since).sort((a, b) => a.timeCreated - b.timeCreated);
    }
    return sessions.sort((a, b) => a.timeCreated - b.timeCreated);
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const filePath = this.sessionFileMap.get(sessionId);
    if (!filePath || !fs.existsSync(filePath)) return [];

    const messages: Message[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let msgIdx = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as JSONLEvent;

        let role: 'user' | 'assistant' | null = null;
        let content: string | null = null;
        let ts: number | undefined;

        if (event.type === 'human' || event.type === 'user') {
          role = 'user';
          if (typeof event.content === 'string') {
            content = event.content;
          } else if (event.message?.content) {
            if (typeof event.message.content === 'string') {
              content = event.message.content;
            } else {
              content = event.message.content
                .filter(b => b.type === 'text')
                .map(b => b.text ?? '')
                .join('\n');
            }
          }
        } else if (event.type === 'assistant') {
          role = 'assistant';
          if (typeof event.content === 'string') {
            content = event.content;
          } else if (Array.isArray(event.content)) {
            content = event.content
              .filter(b => b.type === 'text')
              .map(b => b.text ?? '')
              .join('\n');
          } else if (event.message?.content) {
            if (typeof event.message.content === 'string') {
              content = event.message.content;
            } else {
              content = event.message.content
                .filter(b => b.type === 'text')
                .map(b => b.text ?? '')
                .join('\n');
            }
          }
        }

        if (role && content != null) {
          ts = event.timestamp ? new Date(event.timestamp).getTime() : undefined;
          messages.push({
            id: `${sessionId}:${msgIdx++}`,
            sessionId,
            role,
            content,
            timeCreated: ts ?? 0,
          });
        }
      } catch {
        // Corrupted line, skip per PRD §8.5
      }
    }

    return messages;
  }

  async getTodos(): Promise<Todo[]> {
    const todos: Todo[] = [];

    if (!fs.existsSync(this.todosDir)) return todos;

    const todoFiles = fs.readdirSync(this.todosDir)
      .filter(f => f.endsWith('.json'));

    for (const file of todoFiles) {
      const filePath = path.join(this.todosDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const sessionId = path.basename(file, '.json');
        const fileMtime = fs.statSync(filePath).mtimeMs;

        // Claude Code todos can be an array or object with items
        const items: Array<{ content?: string; status?: string; priority?: string }> =
          Array.isArray(data) ? data : (data.todos ?? data.items ?? []);

        for (const item of items) {
          if (!item.content) continue;
          const status = (item.status ?? 'pending') as Todo['status'];
          if (status !== 'pending' && status !== 'in_progress') continue;

          // Try to find session timeCreated from cache
          const session = this.sessionCache.get(sessionId);
          todos.push({
            sessionId,
            content: item.content,
            status,
            priority: item.priority,
            source: this.name,
            timeCreated: session?.timeCreated ?? fileMtime,
          });
        }
      } catch {
        // Corrupted todo file, skip
      }
    }

    return todos;
  }

  async getNoiseSignals(projectId: string): Promise<NoiseSignals> {
    await this.ensureCache();

    const allSessions = Array.from(this.sessionCache.values());
    const totalSessions = allSessions.length;
    const sessions = allSessions.filter(s => s.projectId === projectId);
    const projectSessionCount = sessions.length;

    // Hour distribution
    const hourDistribution = new Array(24).fill(0);
    for (const s of sessions) {
      const hour = new Date(s.timeCreated).getHours();
      hourDistribution[hour]++;
    }

    // Unique first message ratio — need to read first user msg from each session
    const firstMessages: string[] = [];
    for (const s of sessions) {
      const msgs = await this.getMessages(s.id);
      const firstUserMsg = msgs.find(m => m.role === 'user');
      if (firstUserMsg) {
        firstMessages.push(firstUserMsg.content.trim().slice(0, 200));
      }
    }
    const uniqueFirstMessages = new Set(firstMessages.filter(m => m.length > 0));
    const uniqueFirstMessageRatio = firstMessages.length > 0
      ? uniqueFirstMessages.size / firstMessages.length
      : 1;

    // Median session duration
    const durations = sessions
      .filter(s => s.timeEnd != null)
      .map(s => s.timeEnd! - s.timeCreated)
      .filter(d => d > 0)
      .sort((a, b) => a - b);
    const medianSessionDurationMs = durations.length > 0
      ? durations[Math.floor(durations.length / 2)]
      : 0;

    // Session share percent
    const sessionSharePercent = totalSessions > 0
      ? (projectSessionCount / totalSessions) * 100
      : 0;

    // User message ratio — approximate from messageCount and a sample
    let userMsgCount = 0;
    let totalMsgCount = 0;
    // Sample up to 50 sessions for efficiency
    const sample = sessions.slice(0, 50);
    for (const s of sample) {
      const msgs = await this.getMessages(s.id);
      totalMsgCount += msgs.length;
      userMsgCount += msgs.filter(m => m.role === 'user').length;
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
    return this.sessionCache.get(sessionId);
  }

  /** Look up a cached project by id */
  getProjectById(projectId: string): Project | undefined {
    return this.projectCache.get(projectId);
  }
}
