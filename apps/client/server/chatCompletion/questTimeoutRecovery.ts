import type { IChatHistoryItem } from '@bike4mind/common';

/**
 * A quest is considered stuck as a pure function of LIVENESS, not content: it is still 'running'
 * yet its `updatedAt` has gone stale past this threshold. The server-side streaming heartbeat bumps
 * `updatedAt` every ~10s for as long as the Lambda is alive, so any actively-streaming quest looks
 * fresh well before this; only a genuinely dead run (Lambda hard-killed/OOM, execution-timeout, or a
 * lost terminal WebSocket frame) ages past it.
 *
 * 120s = 12x the 10s streaming heartbeat, so a live run survives many missed beats before it can
 * ever look stuck; only a genuinely dead run (no heartbeat at all) crosses it.
 */
export const QUEST_TIMEOUT_THRESHOLD_MS = 120_000;

/** The subset of a quest the recovery decision reads. */
export type QuestTimeoutView = Pick<IChatHistoryItem, 'status' | 'reply' | 'replies' | 'images' | 'videos'> & {
  updatedAt: Date | string | number;
};

/**
 * The recovery decision for a possibly-stuck quest:
 *  - `null`            -> not stuck; return the quest as-is (this is also how an already-terminal
 *                         quest recovers a lost terminal frame: the client sees its 'done' state).
 *  - `{ status, ... }` -> the terminal update to persist. Content that survived (a killed-after-
 *                         storage image render, or partial replies) is preserved by flipping only
 *                         `status`; the timeout error message is synthesized ONLY when there is
 *                         genuinely nothing to show.
 */
export type QuestTimeoutRecovery = { status: 'done'; type?: 'error'; reply?: string } | null;

const TIMEOUT_REPLY = 'This request timed out. The server did not respond in time. Please try again.';

/**
 * Shown when the abandoned sweep terminates a run that never produced anything.
 * Distinct from TIMEOUT_REPLY because the causes differ operationally: a timeout
 * means the server was too slow, whereas this means the run was declared dead
 * hours later by a background sweep and nobody was waiting on it any more.
 */
export const ABANDONED_REPLY =
  'This request was ended because the run was abandoned before it produced a response. Please try again.';

/** The subset of a quest the terminal-patch decision reads. */
export type QuestContentView = Pick<IChatHistoryItem, 'reply' | 'replies' | 'images' | 'videos'>;

function hasRenderableContent(quest: QuestContentView): boolean {
  return Boolean(quest.reply || quest.replies?.some(r => r) || quest.images?.length || quest.videos?.length);
}

/**
 * The terminal patch for a quest that will never be written to again, whatever
 * declared it dead. Content that survived is preserved by flipping only
 * `status`; `emptyReply` is synthesized ONLY when there is nothing to show, so a
 * partial answer is never replaced by an error message.
 *
 * Shared by the liveness path below and the abandoned sweep, so the two cannot
 * drift on the one rule that matters: never destroy content to report a failure.
 */
export function terminalRecoveryFor(quest: QuestContentView, emptyReply: string): NonNullable<QuestTimeoutRecovery> {
  return hasRenderableContent(quest) ? { status: 'done' } : { status: 'done', type: 'error', reply: emptyReply };
}

/**
 * Decide how (if at all) to recover a quest the client reported as seemingly stuck. Pure and
 * dependency-free so it is unit-testable without a DB; the endpoint owns the read/write.
 *
 * Deliberately independent of reply content: the chat `image_generation` tool streams preamble text
 * before the tool runs, so gating recovery on empty replies (as the endpoint and client poll
 * historically did) locked out exactly the path that hangs and stranded it on an eternal
 * "Running..." spinner (#313). Liveness is the only safe signal, and the heartbeat guarantees a live
 * quest never crosses the threshold.
 */
export function resolveQuestTimeoutRecovery(quest: QuestTimeoutView, nowMs: number): QuestTimeoutRecovery {
  const ageMs = nowMs - new Date(quest.updatedAt).getTime();
  const isStuck = quest.status === 'running' && ageMs > QUEST_TIMEOUT_THRESHOLD_MS;
  if (!isStuck) return null;

  return terminalRecoveryFor(quest, TIMEOUT_REPLY);
}
