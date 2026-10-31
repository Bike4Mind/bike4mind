import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { logger } from '../utils/Logger';

/** One JSONL line in the history file; JSON keeps multi-line entries on one line. */
interface HistoryEntry {
  command: string;
  timestamp: number;
}

export const MAX_HISTORY_ENTRIES = 500;
export const MAX_ENTRY_BYTES = 16 * 1024;

// Past this many lines over the cap the file is rewritten; below it, sessions only append.
const COMPACT_SLACK = 100;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 10;

const SECRET_NAME = String.raw`[\w-]*(api[_-]?key|token|secret|passw(or)?d)[\w-]*`;
const SECRET_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b${SECRET_NAME}["']?\s*[:=]\s*\S`, 'i'),
  new RegExp(String.raw`(^|\s)--?${SECRET_NAME}(=|\s+)\S`, 'i'),
  /:\/\/[^\s/@:]+:[^\s/@]+@/,
  /\b(authorization|x-api-key)\s*:/i,
  /\bbearer\s+[\w.~+/-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\./,
  /\b(b4m_live_|sk-|sk_live_|rk_live_|ghp_|gho_|github_pat_|xox[abprs]-|xapp-|glpat-|hf_|npm_|AIza|AKIA)[\w-]{8,}/,
  /\bmysql(dump)?\b.*\s-p\S/,
  /\bcurl\b.*\s(-u\s*|--user[=\s]+)[^\s:]+:\S/,
  /\bdocker\s+login\b.*\s-p(=|\s+)\S/,
];

/** False for input that may carry a credential: secret-named assignments or flags, URL passwords, auth headers, keys, tokens. */
export function isSafeHistoryEntry(entry: string): boolean {
  return !SECRET_PATTERNS.some(pattern => pattern.test(entry));
}

function isPersistable(command: string): boolean {
  return Buffer.byteLength(command) <= MAX_ENTRY_BYTES && isSafeHistoryEntry(command);
}

function parseLine(line: string): HistoryEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && typeof (parsed as HistoryEntry).command === 'string') {
      const { command, timestamp } = parsed as HistoryEntry;
      return { command, timestamp: typeof timestamp === 'number' ? timestamp : 0 };
    }
  } catch {
    // A torn or hand-edited line is dropped; the rest of the file still loads.
  }
  return null;
}

const serialize = (entry: HistoryEntry) => JSON.stringify(entry) + '\n';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface CommandHistoryStoreOptions {
  maxEntries?: number;
  /** Read and write the file; off keeps history in memory for this session only. Defaults to B4M_NO_HISTORY !== '1'. */
  persist?: boolean;
}

/**
 * Prompt input history (newest first, each command once), shared by every session of this user.
 * No method throws: a missing, unreadable or malformed file means empty history.
 */
export class CommandHistoryStore {
  private readonly historyPath: string;
  private readonly lockPath: string;
  private readonly maxEntries: number;
  private readonly persist: boolean;
  private history: string[] = [];
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private needsLeadingNewline = false;
  private modeChecked = false;

  constructor(historyPath?: string, options: CommandHistoryStoreOptions = {}) {
    this.historyPath = historyPath || path.join(homedir(), '.bike4mind', 'history.jsonl');
    this.lockPath = `${this.historyPath}.lock`;
    this.maxEntries = options.maxEntries ?? MAX_HISTORY_ENTRIES;
    this.persist = options.persist ?? process.env.B4M_NO_HISTORY !== '1';
  }

  async load(): Promise<string[]> {
    // Entries added before the file finished loading are newer than anything in it.
    this.loading ??= this.readFile().then(stored => {
      this.history = newestUnique([...this.history, ...stored]).slice(0, this.maxEntries);
    });
    await this.loading;
    return this.history;
  }

  /**
   * Records an entry and returns the updated history. Entries that may hold a secret or exceed
   * MAX_ENTRY_BYTES stay recallable for this session but are never written.
   */
  add(entry: string): string[] {
    const command = entry.trim();
    if (!command || command === this.history[0]) return this.history;
    this.history = [command, ...this.history.filter(existing => existing !== command)].slice(0, this.maxEntries);
    if (this.persist && isPersistable(command)) {
      const record = { command, timestamp: Date.now() };
      this.writes = this.writes.then(() => this.append(record));
    }
    return this.history;
  }

  /** Resolves once every queued append has reached the file. */
  whenIdle(): Promise<void> {
    return this.writes;
  }

  /** Stored commands, newest first, capped. */
  private async readFile(): Promise<string[]> {
    if (!this.persist) return [];
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.historyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.debug('read', error);
      return [];
    }
    await fs.chmod(this.historyPath, 0o600).catch(error => this.debug('chmod', error));
    this.needsLeadingNewline = buf.length > 0 && buf[buf.length - 1] !== 0x0a;

    const lines = buf
      .toString('utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0);
    const entries: HistoryEntry[] = [];
    let dropped = false;
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry && entry.command.trim() && isPersistable(entry.command)) entries.push(entry);
      else dropped = true;
    }

    const seen = new Set<string>();
    const kept: HistoryEntry[] = [];
    for (let i = entries.length - 1; i >= 0 && kept.length < this.maxEntries; i--) {
      if (seen.has(entries[i].command)) continue;
      seen.add(entries[i].command);
      kept.push(entries[i]);
    }
    if (dropped || lines.length > this.maxEntries + COMPACT_SLACK) {
      await this.compact([...kept].reverse(), buf.length);
    }
    return kept.map(entry => entry.command);
  }

  private async compact(chronological: HistoryEntry[], expectedSize: number): Promise<void> {
    const tmpPath = `${this.historyPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await this.withLock(async () => {
        await fs.writeFile(tmpPath, chronological.map(serialize).join(''), { encoding: 'utf-8', mode: 0o600 });
        // Someone appended since the read (a locked session before we got the lock, or an older CLI that
        // does not lock): keep their entry and compact on a later load.
        if ((await fs.stat(this.historyPath)).size !== expectedSize) {
          await fs.rm(tmpPath, { force: true });
          return;
        }
        await fs.rename(tmpPath, this.historyPath);
        this.needsLeadingNewline = false;
      });
    } catch (error) {
      this.debug('compact', error);
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  private async append(record: HistoryEntry): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.historyPath), { recursive: true, mode: 0o700 });
      // The lock keeps a compaction in another session from replacing the file under this write.
      await this.withLock(() =>
        fs.appendFile(this.historyPath, (this.needsLeadingNewline ? '\n' : '') + serialize(record), {
          encoding: 'utf-8',
          mode: 0o600,
        })
      );
      this.needsLeadingNewline = false;
      if (!this.modeChecked) {
        this.modeChecked = true;
        await fs.chmod(this.historyPath, 0o600);
      }
    } catch (error) {
      this.debug('append', error);
    }
  }

  /** O_EXCL lock file shared by every session; one left behind by a crashed session is taken over after LOCK_STALE_MS. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 2 * LOCK_STALE_MS;
    for (;;) {
      try {
        await (await fs.open(this.lockPath, 'wx', 0o600)).close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() > deadline) throw error;
      }
      const lockAge = await fs.stat(this.lockPath).then(
        stat => Date.now() - stat.mtimeMs,
        () => 0
      );
      if (lockAge > LOCK_STALE_MS) await fs.rm(this.lockPath, { force: true });
      else await delay(LOCK_RETRY_MS);
    }
    try {
      return await fn();
    } finally {
      await fs.rm(this.lockPath, { force: true }).catch(error => this.debug('unlock', error));
    }
  }

  private debug(action: string, error: unknown): void {
    logger.debug(`[HISTORY] ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Keeps the first (newest) copy of each command. */
function newestUnique(commands: string[]): string[] {
  return commands.filter((command, index) => commands.indexOf(command) === index);
}
