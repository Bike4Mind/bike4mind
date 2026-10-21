import type { ChatMessage, ChatUsage } from './chat';

/**
 * How full a conversation's context is, and how full it is allowed to get.
 *
 * Shared because both sides read the same figure: the composer ring draws it, and main decides
 * from it whether a turn compacts first (ChatService.autoCompact). Two copies of the measurement
 * would let the ring say one thing while the compaction acts on another.
 */

/**
 * The most context a conversation carries before it is compacted, whatever the model allows.
 *
 * Every tool round re-sends the whole conversation, so at a 1M window each round reads up to 1M
 * from the prompt cache - cheap per token, not free - and models also answer worse at the far
 * end of a very long context. 400k keeps a long coding session's working set and bounds what a
 * round can cost.
 */
export const CONTEXT_CAP_TOKENS = 400_000;

/**
 * How full the limit may get, in percent, before the next turn compacts first.
 *
 * Only checked as a turn starts, so the 10% left is what that turn's first request has to fit
 * in: the last reply re-sent as input, the new message, and the reply to it. Where the model's
 * own window is the limit, that is what keeps the request from being refused. Also where the
 * composer ring turns red (occupancyColor), so red reads as "the next message compacts first".
 */
export const AUTO_COMPACT_PERCENT = 90;

/** The window the indicator and the compaction both measure against: the model's, capped. */
export function effectiveContextLimit(modelWindow: number | null | undefined): number {
  return modelWindow && modelWindow > 0 ? Math.min(modelWindow, CONTEXT_CAP_TOKENS) : CONTEXT_CAP_TOKENS;
}

export function autoCompactThreshold(limit: number): number {
  return Math.floor((limit * AUTO_COMPACT_PERCENT) / 100);
}

/**
 * Whether a turn starting now should compact the conversation before it is sent.
 *
 * Reads the figure the last request already measured, so the cost is a scan back to the nearest
 * measured reply - nothing is re-tokenised. Replies that measured nothing are passed over, so a
 * turn whose request was refused outright still leaves the one before it to decide on.
 *
 * A boundary ends that scan with nothing measured, which is what stops a compaction from
 * firing again on the next turn: the first figure after it measures the summary, not what the
 * summary replaced.
 */
export function shouldAutoCompact(messages: readonly ChatMessage[], modelWindow: number | null | undefined): boolean {
  const measured = contextTokens(latestReply(messages, true));
  return measured !== null && measured >= autoCompactThreshold(effectiveContextLimit(modelWindow));
}

/**
 * The input side of one request: everything that occupied the context window to serve it.
 *
 * Cache reads are INCLUDED here and excluded from `totalTokens`, and the difference is the
 * whole point of the two functions. `totalTokens` is a COST proxy, so it drops the tokens that
 * were served cheaply from cache; this is an OCCUPANCY measure, and a cached token takes up
 * exactly as much of the window as a fresh one. Folding the two together makes the status line
 * either overprice a tool loop or understate how full it is.
 */
export function inputSide(usage: ChatUsage | null | undefined): number | null {
  if (!usage) return null;
  const parts = [usage.inputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens];
  if (parts.every(part => part === undefined)) return null;
  return parts.reduce((sum: number, part) => sum + (part ?? 0), 0);
}

/**
 * How full the window was when this reply's last request went out.
 *
 * The LAST ROUND's input, never a sum over the rounds. An agent turn makes one request per tool
 * round and each one re-sends the conversation so far, so summing them counts the same context
 * dozens of times over and sails past 100% in any real tool loop. The message's own `usage` is
 * that sum - it is the turn's BILL, and it is the wrong number for this.
 *
 * A message with tool calls but no rounds was stored before rounds were recorded: its per-round
 * inputs were never kept, so the answer is unknown rather than its summed bill.
 */
export function contextTokens(message: ChatMessage | null | undefined): number | null {
  if (!message || message.role !== 'assistant') return null;

  const rounds = message.rounds;
  if (rounds?.length) {
    for (let index = rounds.length - 1; index >= 0; index--) {
      const measured = inputSide(rounds[index].usage);
      if (measured !== null) return measured;
    }
    return null;
  }

  if (message.toolCalls?.length) return null;
  return inputSide(message.usage);
}

/**
 * The reply whose request the context figure describes: the most recent assistant message.
 *
 * Messages typed since are deliberately skipped rather than counted - they will occupy the
 * window on the next request, and this reports what the last one actually used.
 *
 * The scan STOPS at a context boundary, which is what makes the indicator answer the question
 * the user asked `/clear` or `/compact` to change. The request behind a reply from before the
 * boundary measured a window that no longer exists, and reporting it would tell the user their
 * compaction did nothing. With no reply since, the answer is null - not measured yet - and the
 * figure reads as unknown until the next turn states a real one.
 *
 * `turnOpen` exists because a reply being streamed has stated nothing to measure yet. Its
 * `rounds` and its own `usage` both arrive with the terminal event, and the 'usage' events in
 * between carry the turn's running BILL, which is the wrong quantity for occupancy - see
 * inputSide. Read off the open reply, the figure would be unknown for the whole turn, so the
 * indicator would blank itself the moment the user pressed send. With it set, an assistant
 * message that measures nothing is passed over and the last request that DID state a figure is
 * the one reported, which is why the ring holds still through a turn and steps at the end of
 * it. Only while the turn is open: a settled conversation still reports its newest reply, so a
 * stored message that measured nothing still reads as unknown rather than as an older turn.
 */
export function latestReply(messages: readonly ChatMessage[], turnOpen = false): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.boundary) return null;
    if (message.role !== 'assistant') continue;
    if (turnOpen && contextTokens(message) === null) continue;
    return message;
  }
  return null;
}
