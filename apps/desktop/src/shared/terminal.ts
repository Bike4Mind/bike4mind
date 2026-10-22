/**
 * The user's own terminals: a real pty per tab, owned by a conversation.
 *
 * These are the USER typing, never the agent. Nothing on this surface is a tool, no approval
 * gate sits in front of it, and nothing it reads or writes ever reaches a conversation's
 * context - see main/terminal/TerminalManager.
 */

/** Tabs one conversation may hold at once. Each is a live shell. */
export const MAX_TERMINALS_PER_SESSION = 6;

export interface TerminalInfo {
  id: string;
  sessionId: string;
  /** The shell's own name, for the tab. */
  title: string;
  cwd: string;
  /** Bumped by a restart, so a view keyed on it starts over with an empty screen. */
  generation: number;
  /** Null while the shell runs. */
  exit: { code: number; signal: number | null } | null;
}

export interface TerminalCreateRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export type TerminalCreateResult = { ok: true; terminal: TerminalInfo } | { ok: false; error: string };

/**
 * What a view needs to pick a running shell back up: everything it printed that is still
 * retained, then every push after it. Null for a terminal that no longer exists.
 */
export interface TerminalAttachment {
  terminal: TerminalInfo;
  replay: string;
}

/** main -> renderer, coalesced: one push per terminal per flush, never per write. */
export interface TerminalDataEvent {
  terminalId: string;
  data: string;
}

/** main -> renderer: one conversation's whole tab list, after any change to it. */
export interface TerminalsChangedEvent {
  sessionId: string;
  terminals: TerminalInfo[];
}
