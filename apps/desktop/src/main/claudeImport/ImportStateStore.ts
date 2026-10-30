import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { ClaudeChatImportSummary, ClaudeCodeImportSettings } from '@shared/claudeImport';
import { assertScopeKey } from '../chat/sessionScope';
import type { CodeMapState } from './claudeCodeMapper';

export interface ClaudeImportSettings {
  code: ClaudeCodeImportSettings;
  chatWatchFolder: string | null;
  /** When the folder was chosen (ms). Exports older than this were already there, in every account. */
  chatWatchSince: number;
}

export const DEFAULT_SETTINGS: ClaudeImportSettings = {
  code: { enabled: false, sourceFolder: null, projects: 'all', includeSubagents: false },
  chatWatchFolder: null,
  chatWatchSince: 0,
};

/** 'pending' is indexed but not read yet; 'removed' was deleted by the user and stays gone. */
export type FileStatus = 'pending' | 'imported' | 'skipped' | 'failed' | 'forked' | 'removed';

/** Where one transcript's import stands, so the next sync reads only what was appended. */
export interface FileCursor {
  sessionId: string;
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line read. */
  offset: number;
  status: FileStatus;
  cwd?: string;
  /** CODE_MAP_VERSION the copy was made with; absent on cursors from before it existed. */
  mapVersion?: number;
  /** Size when the head was last read for `cwd`, so a file with none is not re-read every pass. */
  peekedSize?: number;
  state?: CodeMapState;
  error?: string;
}

/** Per account: imports land in that account's sessions, so their bookkeeping does too. */
export interface ScopeImportState {
  version: 1;
  files: Record<string, FileCursor>;
  lastSyncAt: string | null;
  lastSyncMs: number | null;
  /** Conversation uuid -> the `updated_at` last imported. */
  conversations: Record<string, string>;
  lastChatImport: ClaudeChatImportSummary | null;
  /** Export zips already seen in the watched folder, path -> mtimeMs. */
  watchedSeen: Record<string, number>;
}

function emptyScopeState(): ScopeImportState {
  return {
    version: 1,
    files: {},
    lastSyncAt: null,
    lastSyncMs: null,
    conversations: {},
    lastChatImport: null,
    watchedSeen: {},
  };
}

function absoluteOrNull(value: unknown): string | null {
  return typeof value === 'string' && isAbsolute(value) ? value : null;
}

export function sanitizeSettings(raw: unknown): ClaudeImportSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<ClaudeImportSettings>;
  const code = (value.code && typeof value.code === 'object' ? value.code : {}) as Partial<ClaudeCodeImportSettings>;
  return {
    code: {
      enabled: code.enabled === true,
      sourceFolder: absoluteOrNull(code.sourceFolder),
      projects: Array.isArray(code.projects)
        ? code.projects.filter((entry): entry is string => typeof entry === 'string' && isAbsolute(entry))
        : 'all',
      includeSubagents: code.includeSubagents === true,
    },
    chatWatchFolder: absoluteOrNull(value.chatWatchFolder),
    chatWatchSince:
      typeof value.chatWatchSince === 'number' && Number.isFinite(value.chatWatchSince) ? value.chatWatchSince : 0,
  };
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, contents, 'utf8');
  await rename(`${path}.tmp`, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export class ImportStateStore {
  private settings: ClaudeImportSettings | null = null;
  /** Promises, not values: two first reads racing must share one object, or one's writes are lost. */
  private readonly scopes = new Map<string, Promise<ScopeImportState>>();
  private readonly loaded = new Map<string, ScopeImportState>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settingsPath: string,
    private readonly stateDirectory: string
  ) {}

  async readSettings(): Promise<ClaudeImportSettings> {
    this.settings ??= sanitizeSettings(await readJson(this.settingsPath));
    return this.settings;
  }

  async writeSettings(next: ClaudeImportSettings): Promise<ClaudeImportSettings> {
    this.settings = sanitizeSettings(next);
    const snapshot = JSON.stringify(this.settings, null, 2);
    await this.queue(() => atomicWrite(this.settingsPath, snapshot));
    return this.settings;
  }

  scope(scopeKey: string): Promise<ScopeImportState> {
    let loading = this.scopes.get(scopeKey);
    if (!loading) {
      loading = readJson(this.scopePath(scopeKey)).then(raw => {
        const parsed = raw as Partial<ScopeImportState> | null;
        const state = parsed?.version === 1 ? { ...emptyScopeState(), ...parsed } : emptyScopeState();
        this.loaded.set(scopeKey, state);
        return state;
      });
      this.scopes.set(scopeKey, loading);
    }
    return loading;
  }

  async saveScope(scopeKey: string): Promise<void> {
    const state = this.loaded.get(scopeKey);
    if (!state) return;
    const snapshot = JSON.stringify(state);
    await this.queue(() => atomicWrite(this.scopePath(scopeKey), snapshot));
  }

  private scopePath(scopeKey: string): string {
    return join(this.stateDirectory, `${assertScopeKey(scopeKey)}.json`);
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.writing.then(work);
    this.writing = next.catch(() => undefined);
    return next;
  }
}
