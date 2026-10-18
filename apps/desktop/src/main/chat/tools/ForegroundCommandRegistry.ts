import type { BackgroundProcessInfo, ChatMoveToBackgroundResult } from '@shared/chat';

/**
 * Promote the command this entry stands for. Null once it has finished on its own, which is a
 * race the user can always lose: the command may exit between the row being drawn and clicked.
 */
export type MoveToBackground = () => BackgroundProcessInfo | null;

function keyOf(sessionId: string, callId: string): string {
  // NUL separates the fields because it is the one byte neither of them can contain.
  return `${sessionId}\0${callId}`;
}

/**
 * The foreground commands a user may still move to the background, by the tool call they belong
 * to.
 *
 * Keyed on the conversation as well as the call, for the same reason background processes are:
 * one conversation must not be able to reach another's work by naming a handle.
 *
 * Entries live only as long as their command runs. Nothing is persisted and nothing lingers: a
 * command that ends withdraws itself, so an id the renderer still holds from a settled row
 * resolves to "no longer running" rather than to whatever took its place.
 */
export class ForegroundCommandRegistry {
  private readonly moves = new Map<string, MoveToBackground>();

  /** Returns the withdrawal, which the command calls when it ends, however it ends. */
  register(sessionId: string, callId: string, move: MoveToBackground): () => void {
    const key = keyOf(sessionId, callId);
    this.moves.set(key, move);
    return () => {
      if (this.moves.get(key) === move) this.moves.delete(key);
    };
  }

  /**
   * Never throws. A command that has already finished and one refused by the background cap are
   * both answers the user is entitled to read, not faults for the IPC layer to turn into a
   * rejected promise with no row to show it against.
   */
  moveToBackground(sessionId: string, callId: string): ChatMoveToBackgroundResult {
    const move = this.moves.get(keyOf(sessionId, callId));
    const gone = { ok: false, message: 'That command is no longer running.' } as const;
    if (!move) return gone;

    try {
      const info = move();
      return info ? { ok: true, process: info } : gone;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'That command could not be moved.' };
    }
  }
}
