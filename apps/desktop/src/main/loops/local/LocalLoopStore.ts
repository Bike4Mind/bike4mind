import { DatabaseSync } from 'node:sqlite';
import { startOfUtcDay, WORK_ITEM_STAGE_HISTORY_MAX, type WorkItemPatch } from '@bike4mind/common';
import type { LocalLoop, LocalLoopEvent, LocalRun, LocalTicket } from '@shared/localLoops';

const SCHEMA_VERSION = 1;

type Table = 'loops' | 'tickets' | 'runs' | 'events';

/**
 * Desktop-owned loops: the source of truth for their loops, tickets, runs and events. `node:sqlite` in userData,
 * one scope (account + environment) at a time, like LocalHistory. Rows are JSON with the columns queries need.
 * Every method is synchronous and every write commits before `changed(loopId)` fires, so a move the renderer
 * sends is stored before the IPC call returns.
 */
export class LocalLoopStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly scope: () => string | null,
    private readonly changed: (loopId: string) => void = () => {}
  ) {
    this.db = new DatabaseSync(path);
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) throw new Error('Loops were saved by a newer Bike4Mind version.');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS loops(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, scope TEXT NOT NULL, loop_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, loop_id TEXT NOT NULL,
          started_at TEXT NOT NULL, ended INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, scope TEXT NOT NULL, loop_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(scope TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope, key));
        CREATE INDEX IF NOT EXISTS tickets_loop ON tickets(scope, loop_id);
        CREATE INDEX IF NOT EXISTS runs_loop ON runs(scope, loop_id, started_at);
        CREATE INDEX IF NOT EXISTS runs_open ON runs(scope, ended);
        CREATE INDEX IF NOT EXISTS events_loop ON events(scope, loop_id);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireScope(): string {
    const scope = this.scope();
    if (!scope) throw new Error('Sign in to use Loops.');
    return scope;
  }

  private rows<T>(sql: string, ...params: (string | number)[]): T[] {
    const scope = this.scope();
    if (!scope) return [];
    return (this.db.prepare(sql).all(scope, ...params) as { data: string }[]).map(row => JSON.parse(row.data) as T);
  }

  private one<T>(table: Table, id: string): T | null {
    return this.rows<T>(`SELECT data FROM ${table} WHERE scope = ? AND id = ?`, id)[0] ?? null;
  }

  /** Several writes as one: all or none, and one `changed` per loop touched, after the commit. */
  transaction<T>(write: () => T): T {
    if (this.pending) return write();
    this.pending = new Set();
    this.db.exec('BEGIN IMMEDIATE');
    let touched: Set<string>;
    try {
      const result = write();
      this.db.exec('COMMIT');
      touched = this.pending;
      this.pending = undefined;
      for (const loopId of touched) this.changed(loopId);
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.pending = undefined;
      throw error;
    }
  }

  private pending: Set<string> | undefined;

  private touch(loopId: string): void {
    if (this.pending) this.pending.add(loopId);
    else this.changed(loopId);
  }

  loops(): LocalLoop[] {
    return this.rows<LocalLoop>('SELECT data FROM loops WHERE scope = ? ORDER BY rowid');
  }

  loop(id: string): LocalLoop | null {
    return this.one<LocalLoop>('loops', id);
  }

  putLoop(loop: LocalLoop): LocalLoop {
    const scope = this.requireScope();
    this.db
      .prepare('INSERT INTO loops(id, scope, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(loop.id, scope, JSON.stringify(loop));
    this.touch(loop.id);
    return loop;
  }

  deleteLoop(id: string): void {
    const scope = this.requireScope();
    this.transaction(() => {
      for (const table of ['tickets', 'runs', 'events'] as const)
        this.db.prepare(`DELETE FROM ${table} WHERE scope = ? AND loop_id = ?`).run(scope, id);
      this.db.prepare('DELETE FROM loops WHERE scope = ? AND id = ?').run(scope, id);
      this.touch(id);
    });
  }

  tickets(loopId: string): LocalTicket[] {
    return this.rows<LocalTicket>('SELECT data FROM tickets WHERE scope = ? AND loop_id = ? ORDER BY rowid', loopId);
  }

  ticket(id: string): LocalTicket | null {
    return this.one<LocalTicket>('tickets', id);
  }

  putTicket(ticket: LocalTicket): LocalTicket {
    const scope = this.requireScope();
    this.db
      .prepare(
        'INSERT INTO tickets(id, scope, loop_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
      )
      .run(ticket.id, scope, ticket.loopId, JSON.stringify(ticket));
    this.touch(ticket.loopId);
    return ticket;
  }

  deleteTicket(ticket: LocalTicket): void {
    this.db.prepare('DELETE FROM tickets WHERE scope = ? AND id = ?').run(this.requireScope(), ticket.id);
    this.touch(ticket.loopId);
  }

  /** The loop's runs, newest first; `since` (ISO) keeps those started at or after it. */
  runs(loopId: string, since = ''): LocalRun[] {
    return this.rows<LocalRun>(
      'SELECT data FROM runs WHERE scope = ? AND loop_id = ? AND started_at >= ? ORDER BY started_at DESC',
      loopId,
      since
    );
  }

  run(id: string): LocalRun | null {
    return this.one<LocalRun>('runs', id);
  }

  /** Runs with no end in this scope: in flight, or cut off by a quit or crash. */
  openRuns(): LocalRun[] {
    return this.rows<LocalRun>('SELECT data FROM runs WHERE scope = ? AND ended = 0');
  }

  putRun(run: LocalRun): LocalRun {
    const scope = this.requireScope();
    this.db
      .prepare(
        `INSERT INTO runs(id, scope, loop_id, started_at, ended, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ended = excluded.ended, data = excluded.data`
      )
      .run(run.id, scope, run.loopId, run.startedAt, run.endedAt ? 1 : 0, JSON.stringify(run));
    this.touch(run.loopId);
    return run;
  }

  /** Credits the loop's runs started since 00:00 UTC have used, in-flight ones included. */
  spentToday(loopId: string, now: Date): number {
    return this.runs(loopId, startOfUtcDay(now).toISOString()).reduce((sum, run) => sum + run.credits, 0);
  }

  /** The same across every Desktop loop in this scope. */
  spentTodayAllLoops(now: Date): number {
    return this.rows<LocalRun>(
      'SELECT data FROM runs WHERE scope = ? AND started_at >= ?',
      startOfUtcDay(now).toISOString()
    ).reduce((sum, run) => sum + run.credits, 0);
  }

  events(loopId: string): LocalLoopEvent[] {
    return this.rows<LocalLoopEvent>(
      'SELECT data FROM events WHERE scope = ? AND loop_id = ? ORDER BY rowid DESC',
      loopId
    );
  }

  event(id: string): LocalLoopEvent | null {
    return this.one<LocalLoopEvent>('events', id);
  }

  putEvent(event: LocalLoopEvent): LocalLoopEvent {
    const scope = this.requireScope();
    this.db
      .prepare(
        'INSERT INTO events(id, scope, loop_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
      )
      .run(event.id, scope, event.loopId, JSON.stringify(event));
    this.touch(event.loopId);
    return event;
  }

  setting<T>(key: string): T | undefined {
    const scope = this.scope();
    if (!scope) return undefined;
    const row = this.db.prepare('SELECT data FROM settings WHERE scope = ? AND key = ?').get(scope, key) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings(scope, key, data) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET data = excluded.data'
      )
      .run(this.requireScope(), key, JSON.stringify(value));
  }
}

const iso = (date: Date | null | undefined): string | undefined => (date ? new Date(date).toISOString() : undefined);

/**
 * A ticket with a shared-rule patch (`ticketMovePatch`, `priorityPatch`, `advancePatch`) applied: `null` clears a
 * field, dates become ISO strings, and a `stageHistoryEntry` is pushed onto the capped history.
 */
export function applyTicketPatch(ticket: LocalTicket, patch: WorkItemPatch, now = new Date()): LocalTicket {
  const next: Record<string, unknown> = { ...ticket, updatedAt: now.toISOString() };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'stageHistoryEntry' || value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value instanceof Date ? value.toISOString() : value;
  }
  const entry = patch.stageHistoryEntry;
  const history = entry
    ? [...ticket.stageHistory, { stage: entry.stage, at: iso(entry.at)!, by: entry.by }].slice(
        -WORK_ITEM_STAGE_HISTORY_MAX
      )
    : ticket.stageHistory;
  return { ...(next as unknown as LocalTicket), stageHistory: history };
}
