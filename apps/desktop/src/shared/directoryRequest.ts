import type { ChatSessionSummary } from './chat';

/**
 * The `request_directory` tool, as both processes see it. Main owns the grant; the renderer only
 * draws the card and reads the settled outcome back out of the call's input.
 */
export const REQUEST_DIRECTORY_TOOL_NAME = 'request_directory';

/**
 * What became of a request. 'already' never showed a card: the folder was inside a root before
 * the call. 'cancelled' is a stop, an interrupt or a new message closing the card unanswered.
 */
export type DirectoryRequestOutcome =
  { status: 'granted' } | { status: 'already' } | { status: 'declined' } | { status: 'cancelled' };

export function parseDirectoryOutcome(value: unknown): DirectoryRequestOutcome | null {
  const status = (value as { status?: unknown } | null)?.status;
  return status === 'granted' || status === 'already' || status === 'declined' || status === 'cancelled'
    ? { status }
    : null;
}

/**
 * What a user-driven share (the chip's picker or `/add-dir`) came to. `path` is the real path,
 * which can differ from what was typed. 'cancelled' is a dismissed picker, not an error.
 */
export type ShareDirectoryResult =
  | { status: 'added'; path: string; session: ChatSessionSummary; warning?: string }
  | { status: 'already'; path: string }
  | { status: 'refused'; error: string }
  | { status: 'cancelled' };
