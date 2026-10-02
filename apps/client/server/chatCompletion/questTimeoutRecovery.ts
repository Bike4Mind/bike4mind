import {
  RUN_ABANDONED_FINISH_REASON,
  RUN_TIMED_OUT_FINISH_REASON,
  visibleReplyText,
  type IChatHistoryItem,
} from '@bike4mind/common';

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
export type QuestTimeoutView = Pick<IChatHistoryItem, 'status'> &
  QuestContentView & {
    updatedAt: Date | string | number;
  };

/**
 * The recovery decision for a possibly-stuck quest:
 *  - `null`            -> not stuck; return the quest as-is (this is also how an already-terminal
 *                         quest recovers a lost terminal frame: the client sees its 'done' state).
 *  - `{ status, ... }` -> the terminal update to persist. Content that survived (a killed-after-
 *                         storage image render, or partial replies) is preserved and marked
 *                         unfinished via `finishReason` (persisted as `promptMeta.finishReason`);
 *                         the timeout error message is synthesized ONLY when there is genuinely
 *                         nothing to show.
 */
export type QuestTimeoutRecovery = {
  status: 'done';
  type?: 'error';
  reply?: string;
  replies?: string[];
  fallbackInfo?: null;
  finishReason?: typeof RUN_TIMED_OUT_FINISH_REASON | typeof RUN_ABANDONED_FINISH_REASON;
} | null;

const TIMEOUT_REPLY = 'This request timed out. The server did not respond in time. Please try again.';

/**
 * Shown when the abandoned sweep terminates a run that never produced anything.
 * Distinct from TIMEOUT_REPLY because the causes differ operationally: a timeout
 * means the server was too slow, whereas this means the run was declared dead
 * hours later by a background sweep and nobody was waiting on it any more.
 */
export const ABANDONED_REPLY =
  'This request was ended because the run was abandoned before it produced a response. Please try again.';

/** Appended to the surviving text of a run that died mid-turn, e.g. killed during a tool call. */
export const UNFINISHED_REPLY_NOTICE =
  'The response was cut off because the server stopped before it finished, so this answer is incomplete. Please try again.';

export const TIMED_OUT_RUN = { emptyReply: TIMEOUT_REPLY, finishReason: RUN_TIMED_OUT_FINISH_REASON } as const;
export const ABANDONED_RUN = { emptyReply: ABANDONED_REPLY, finishReason: RUN_ABANDONED_FINISH_REASON } as const;
type DeadRunKind = typeof TIMED_OUT_RUN | typeof ABANDONED_RUN;

/** The subset of a quest the terminal-patch decision reads. */
export type QuestContentView = Pick<
  IChatHistoryItem,
  'reply' | 'replies' | 'images' | 'videos' | 'structuredReplies' | 'toolResults'
>;

/**
 * `structuredReplies` / `toolResults` count as content. A tool-heavy run can
 * produce a fully renderable answer (notebook cells, tool output) while leaving
 * `reply`, `replies`, `images` and `videos` all empty, and calling that "nothing
 * to show" stamps an error message next to work the user can actually see.
 *
 * Every field is tested for content rather than for presence, because the two
 * failure modes are not symmetric. Mistaking content for emptiness replaces a
 * real answer with an error; mistaking emptiness for content produces a
 * terminal bubble with neither an answer nor an error - the silent blank the
 * abandoned-run message exists to prevent. An assistant turn carrying no
 * content blocks and a tool result with an empty body both render nothing.
 *
 * `reply`/`replies` are checked through `visibleReplyText`, not a bare truthy
 * check: a process that died mid-stream can leave behind nothing but an
 * unclosed `<think>` marker, which is real text but renders nothing (#3223) -
 * counting it as content would mark the quest done with no error and no answer.
 */
function hasRenderableContent(quest: QuestContentView): boolean {
  return Boolean(
    visibleReplyText(quest.reply) ||
    quest.replies?.some(r => visibleReplyText(r)) ||
    quest.images?.length ||
    quest.videos?.length ||
    quest.structuredReplies?.some(sr => sr?.content?.length) ||
    quest.toolResults?.some(t => t?.content)
  );
}

/**
 * The notice goes in its own reply slot, the same shape the chat path uses for its
 * incomplete-answer notice, and `reply` is rebuilt from the visible slots so the two agree.
 * A quest carrying only `reply` (no slots) gets the notice appended there instead, since
 * rebuilding from empty slots would erase the text it is meant to annotate.
 */
function withUnfinishedNotice(quest: QuestContentView): Pick<NonNullable<QuestTimeoutRecovery>, 'reply' | 'replies'> {
  const notice = `\n\n${UNFINISHED_REPLY_NOTICE}`;
  if (quest.replies?.length) {
    const replies = [...quest.replies, notice];
    return { replies, reply: replies.map(slot => visibleReplyText(slot)).join('') };
  }
  return { reply: `${quest.reply ?? ''}${notice}` };
}

/**
 * The terminal patch for a quest that will never be written to again, whatever
 * declared it dead. Content that survived is kept and stamped with the run's
 * `finishReason`, so neither the chat UI nor a polling caller mistakes it for a
 * finished answer; `emptyReply` is synthesized ONLY when there is nothing to
 * show, so a partial answer is never replaced by an error message.
 *
 * The visible notice is skipped when the run delivered an image or video: that
 * is the answer even if the caption was cut short, and "please try again" would
 * re-run a paid generation. The `finishReason` stamp still records the death.
 *
 * Shared by the liveness path below and the abandoned sweep, so the two cannot
 * drift on the one rule that matters: never destroy content to report a failure.
 */
export function terminalRecoveryFor(quest: QuestContentView, run: DeadRunKind): NonNullable<QuestTimeoutRecovery> {
  // fallbackInfo is cleared with the error: no model answered a turn that settles with nothing to show.
  if (!hasRenderableContent(quest)) return { status: 'done', type: 'error', reply: run.emptyReply, fallbackInfo: null };
  const deliveredMedia = Boolean(quest.images?.length || quest.videos?.length);
  return { status: 'done', finishReason: run.finishReason, ...(deliveredMedia ? {} : withUnfinishedNotice(quest)) };
}

/**
 * Mirror a persisted recovery onto the in-memory quest it was computed from, so a handler can
 * return what the write stored without re-reading it.
 */
export function applyRecoveryInMemory(
  quest: Partial<Pick<IChatHistoryItem, 'status' | 'type' | 'reply' | 'replies' | 'promptMeta' | 'fallbackInfo'>>,
  recovery: NonNullable<QuestTimeoutRecovery>
): void {
  const { finishReason, ...fields } = recovery;
  Object.assign(quest, fields);
  if (finishReason) quest.promptMeta = { ...quest.promptMeta, finishReason };
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

  return terminalRecoveryFor(quest, TIMED_OUT_RUN);
}
