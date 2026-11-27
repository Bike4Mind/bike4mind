/** How many identical calls in a row make a loop. Matches opencode's threshold. */
export const THRESHOLD = 3;

/** Inputs that only describe a call to the user (see shellApproval), so rewording one is not a new call. */
const DISPLAY_ONLY_INPUTS: Record<string, readonly string[]> = {
  bash_execute: ['description'],
  bash_background: ['description'],
};

/**
 * Remembers the last few tool calls of each conversation, so the same call made again and again
 * can be noticed. Calls match on the tool and its exact input, as opencode's processor does,
 * less any input that is display only.
 */
export class DoomLoopTracker {
  private readonly recent = new Map<string, string[]>();

  /** Records a call and says whether it is the third identical one in a row. */
  record(sessionId: string, tool: string, input: Record<string, unknown>): boolean {
    const ignored = Object.hasOwn(DISPLAY_ONLY_INPUTS, tool) ? DISPLAY_ONLY_INPUTS[tool] : [];
    const compared = Object.fromEntries(Object.entries(input).filter(([key]) => !ignored.includes(key)));
    const signature = `${tool}\x00${JSON.stringify(compared)}`;
    const calls = [...(this.recent.get(sessionId) ?? []), signature].slice(-THRESHOLD);
    this.recent.set(sessionId, calls);
    return calls.length === THRESHOLD && calls.every(call => call === signature);
  }

  forget(sessionId: string): void {
    this.recent.delete(sessionId);
  }
}
