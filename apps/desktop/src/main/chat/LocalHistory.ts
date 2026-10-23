import { DatabaseSync } from 'node:sqlite';
import type { BrowserPageModel } from '@shared/browserPage';
import type { ChatSession } from '@shared/chat';
import type { LocalHistoryResult, LocalHistoryState } from '@shared/history';
import { redact } from '../devlog/redact';

const SCHEMA_VERSION = 3;
const MAX_ENTRIES = 10_000;
const MAX_CONTENT_CHARS = 100_000;
const EMBEDDING_SIZE = 64;

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function safeContent(value: string): string {
  return redact(value)
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, MAX_CONTENT_CHARS);
}

export class LocalHistory {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly scope: () => string | null = () => 'default'
  ) {
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  captureSession(session: ChatSession): void {
    if (!session.historyEnabled || !this.scope()) return;
    const content = safeContent(
      session.messages
        .filter(message => !message.system)
        .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
        .join('\n')
    );
    this.put(`session:${session.id}`, 'session', session.id, session.title, '', content, session.updatedAt);
  }

  capturePage(sessionId: string, model: BrowserPageModel): void {
    if (!this.scope()) return;
    const content = safeContent(
      model.blocks
        .flatMap(block => ('text' in block ? [block.text] : block.kind === 'image' ? [block.alt] : []))
        .join('\n')
    );
    const url = safeUrl(model.url);
    if (!url || !content.trim()) return;
    this.put(`page:${sessionId}:${url}`, 'page', sessionId, safeContent(model.title), url, content, model.capturedAt);
  }

  search(query: string, limit = 30): LocalHistoryResult[] {
    const match = query
      .trim()
      .split(/\s+/)
      .map(term => `"${term.replaceAll('"', '""')}"`)
      .join(' AND ');
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT e.id, e.kind, e.session_id, e.title, e.url, e.captured_at,
              snippet(entries_fts, 1, '<mark>', '</mark>', '...', 20) AS snippet
         FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
        WHERE entries_fts MATCH ? AND e.scope = ? ORDER BY bm25(entries_fts), e.captured_at DESC LIMIT ?`
      )
      .all(match, this.scope() ?? '', Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
    const lexical = rows.map(toResult);
    if (lexical.length >= limit) return lexical;
    const seen = new Set(lexical.map(row => row.id));
    const queryVector = embedding(query);
    const semantic = (
      this.db
        .prepare(
          'SELECT id, kind, session_id, title, url, captured_at, content, embedding FROM entries WHERE scope = ? ORDER BY captured_at DESC LIMIT 500'
        )
        .all(this.scope() ?? '') as Record<string, unknown>[]
    )
      .filter(row => !seen.has(String(row.id)))
      .map(row => ({ row, score: cosine(queryVector, parseEmbedding(String(row.embedding ?? ''))) }))
      .filter(candidate => candidate.score >= 0.2)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit - lexical.length)
      .map(({ row }) => toResult({ ...row, snippet: snippet(String(row.content ?? ''), query) }));
    return [...lexical, ...semantic];
  }

  clear(): LocalHistoryState {
    this.db.exec('DELETE FROM entries');
    return { entries: 0 };
  }

  state(): LocalHistoryState {
    const row = this.db
      .prepare('SELECT CAST(COUNT(*) AS TEXT) AS count FROM entries WHERE scope = ?')
      .get(this.scope() ?? '') as { count: string };
    return { entries: Number(row.count) };
  }

  private put(
    id: string,
    kind: string,
    sessionId: string,
    title: string,
    url: string,
    content: string,
    at: string
  ): void {
    const scope = this.scope();
    if (!scope) return;
    const storedId = `${scope}:${id}`;
    this.db
      .prepare(
        `INSERT INTO entries(id, kind, session_id, title, url, content, captured_at, embedding, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content,
         captured_at=excluded.captured_at, embedding=excluded.embedding`
      )
      .run(
        storedId,
        kind,
        sessionId,
        title,
        url,
        content,
        at,
        JSON.stringify(embedding(`${title}\n${content}`)),
        scope
      );
    this.db
      .prepare(
        'DELETE FROM entries WHERE rowid IN (SELECT rowid FROM entries ORDER BY captured_at DESC LIMIT -1 OFFSET ?)'
      )
      .run(MAX_ENTRIES);
  }

  private migrate(): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) throw new Error('Local history was created by a newer Bike4Mind version.');
    if (version === 1) this.db.exec("ALTER TABLE entries ADD COLUMN embedding TEXT NOT NULL DEFAULT '[]'");
    if (version > 0 && version < 3) {
      this.db.exec("ALTER TABLE entries ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
      const scope = this.scope();
      if (scope) this.db.prepare('UPDATE entries SET id = ? || id, scope = ?').run(`${scope}:`, scope);
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL,
        title TEXT NOT NULL, url TEXT NOT NULL, content TEXT NOT NULL, captured_at TEXT NOT NULL,
        embedding TEXT NOT NULL DEFAULT '[]', scope TEXT NOT NULL DEFAULT '');
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(title, content, content='entries', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;
      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO entries_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    if (version === 1) {
      const rows = this.db.prepare('SELECT id, title, content FROM entries').all() as {
        id: string;
        title: string;
        content: string;
      }[];
      const update = this.db.prepare('UPDATE entries SET embedding = ? WHERE id = ?');
      for (const row of rows) update.run(JSON.stringify(embedding(`${row.title}\n${row.content}`)), row.id);
    }
  }
}

function toResult(row: Record<string, unknown>): LocalHistoryResult {
  return {
    id: String(row.id),
    kind: row.kind === 'page' ? 'page' : 'session',
    sessionId: String(row.session_id),
    title: String(row.title),
    ...(row.url ? { url: String(row.url) } : {}),
    snippet: String(row.snippet ?? ''),
    capturedAt: String(row.captured_at),
  };
}

function embedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_SIZE).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) {
    let hash = 2166136261;
    for (const char of token) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    vector[Math.abs(hash) % EMBEDDING_SIZE] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
}

function parseEmbedding(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== EMBEDDING_SIZE || right.length !== EMBEDDING_SIZE) return 0;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function snippet(content: string, query: string): string {
  const token = query.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const index = content.toLowerCase().indexOf(token);
  const start = Math.max(0, index < 0 ? 0 : index - 80);
  return content.slice(start, start + 240);
}
