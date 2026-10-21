/**
 * Conversations brought in from Claude: Claude Code transcripts (synced from
 * `~/.claude/projects`) and claude.ai chats (from the user's data export). Read-only on the
 * source side - see main/claudeImport for the importers.
 */

export type ClaudeImportKind = 'claude-code' | 'claude-chat';

/**
 * Where an imported session came from. Separate from ChatSessionOrigin, which is agent-spawn
 * lineage and is counted by the spawn caps.
 */
export interface ChatImportOrigin {
  kind: ClaudeImportKind;
  /** The Claude session id, subagent id, or conversation uuid. */
  sourceId: string;
  sourcePath?: string;
  importedAt: string;
  sourceUpdatedAt: string;
  /**
   * Set once the user continued the session here. From then on the import never writes to it
   * again, so a desktop turn can never be overwritten by a later sync.
   */
  forkedAt?: string;
  /** Claude Code only: where the session ran, kept even when that folder is not on this machine. */
  cwd?: string;
  gitBranch?: string;
  /** A subagent transcript's parent Claude session. */
  parentSourceId?: string;
}

/**
 * Every imported message id starts with its source's prefix; one that does not was written by
 * this app, which is how a sync tells a continued session from an untouched one.
 */
export const IMPORTED_MESSAGE_PREFIX: Readonly<Record<ClaudeImportKind, string>> = {
  'claude-code': 'cc-',
  'claude-chat': 'cl-',
};

export function isImportedMessageId(id: string): boolean {
  return id.startsWith(IMPORTED_MESSAGE_PREFIX['claude-code']) || id.startsWith(IMPORTED_MESSAGE_PREFIX['claude-chat']);
}

export function normalizeImportOrigin(value: unknown): ChatImportOrigin | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ChatImportOrigin>;
  if (raw.kind !== 'claude-code' && raw.kind !== 'claude-chat') return null;
  if (typeof raw.sourceId !== 'string' || !raw.sourceId) return null;
  const text = (key: keyof ChatImportOrigin) => (typeof raw[key] === 'string' && raw[key] ? { [key]: raw[key] } : {});
  return {
    kind: raw.kind,
    sourceId: raw.sourceId,
    importedAt: typeof raw.importedAt === 'string' ? raw.importedAt : '',
    sourceUpdatedAt: typeof raw.sourceUpdatedAt === 'string' ? raw.sourceUpdatedAt : '',
    ...text('sourcePath'),
    ...text('forkedAt'),
    ...text('cwd'),
    ...text('gitBranch'),
    ...text('parentSourceId'),
  };
}

export interface ClaudeImportCounts {
  found: number;
  imported: number;
  skipped: number;
  failed: number;
}

export interface ClaudeCodeProject {
  /** The repository whose .claude/worktrees the sessions ran in; also the filter key. */
  cwd: string;
  name: string;
  sessions: number;
}

export interface ClaudeCodeImportSettings {
  enabled: boolean;
  /** Null means the default, `~/.claude/projects`. */
  sourceFolder: string | null;
  /** 'all', or the project cwds to import. */
  projects: 'all' | string[];
  includeSubagents: boolean;
}

export interface ClaudeChatImportSummary {
  at: string;
  fileName: string;
  counts: ClaudeImportCounts & { updated: number; unchanged: number };
  error?: string;
  /** Some failure may clear on its own (a write or attachment error), unlike an unreadable conversation. */
  retryable?: boolean;
}

export interface ClaudeImportState {
  /** Imports land in the signed-in account's sessions, so nothing runs while signed out. */
  signedIn: boolean;
  code: {
    settings: ClaudeCodeImportSettings;
    /** The folder actually read: the setting, or the default. */
    sourceFolder: string;
    running: boolean;
    lastSyncAt: string | null;
    lastSyncMs: number | null;
    counts: ClaudeImportCounts;
    forked: number;
    projects: ClaudeCodeProject[];
    error?: string;
  };
  chat: {
    watchFolder: string | null;
    running: boolean;
    lastImport: ClaudeChatImportSummary | null;
  };
}

export type ClaudeImportResult = { ok: true; state: ClaudeImportState } | { ok: false; error: string };

export interface ClaudeRemoveResult {
  removed: number;
  /** Continued sessions hold the user's own turns, so they are left in place. */
  keptForked: number;
}

/** Where the claude.ai export lives, for the Settings link. */
export const CLAUDE_EXPORT_HELP_URL =
  'https://support.claude.com/en/articles/9450526-how-can-i-export-my-claude-ai-data';

/**
 * `<repository>/.claude/worktrees/<name>`, the worktrees Claude Code makes for its own sessions.
 * The sidebar files every session in one under its repository, and only sessions that ran in
 * one sync from Claude Code: other tools drive Claude Code from worktrees of their own
 * (and the CLI runs anywhere), and those are not the user's sessions to mirror.
 */
export function claudeWorktreeOf(cwd: string | undefined): { repository: string; worktree: string } | null {
  const match = cwd ? /^(.+?)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/.exec(cwd) : null;
  return match ? { repository: match[1], worktree: match[0] } : null;
}
