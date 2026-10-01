/** How many identical calls in a row make a loop. Matches opencode's threshold. */
const THRESHOLD = 3;

/**
 * Remembers the last few tool calls of each conversation, so the same call made again and again
 * can be noticed. Calls match on the tool and its exact input, as opencode's processor does.
 */
export class DoomLoopTracker {
  private readonly recent = new Map<string, string[]>();

  /** Records a call and says whether it is the third identical one in a row. */
  record(sessionId: string, tool: string, input: Record<string, unknown>): boolean {
    const signature = `${tool}\x00${JSON.stringify(input)}`;
    const calls = [...(this.recent.get(sessionId) ?? []), signature].slice(-THRESHOLD);
    this.recent.set(sessionId, calls);
    return calls.length === THRESHOLD && calls.every(call => call === signature);
  }

  forget(sessionId: string): void {
    this.recent.delete(sessionId);
  }
}
