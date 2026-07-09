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

function hasRenderableContent(quest: QuestTimeoutView): boolean {
  return Boolean(quest.reply || quest.replies?.some(r => r) || quest.images?.length || quest.videos?.length);
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

  return hasRenderableContent(quest) ? { status: 'done' } : { status: 'done', type: 'error', reply: TIMEOUT_REPLY };
}
