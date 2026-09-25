import type { IMessage, MessageContentObject } from '@bike4mind/common';

/**
 * How much of the flagged answer is quoted back. A corrected answer is often long, and the point of
 * the quote is to identify WHICH answer is being corrected - the model still has the full turn in
 * conversation history when it is recent enough to be in the window. Truncation is announced rather
 * than silent so the model does not treat the tail as the end of what it said.
 *
 * The quote is emitted as its own prompt source (`correctionQuote`) precisely because of this size:
 * see SYSTEM_PROMPT_PRIORITY in systemPromptSources.ts for why it must not ride the framing's rank.
 */
export const MAX_QUOTED_ANSWER_CHARS = 4000;

/** Same, for the request that produced it; prompts are far shorter, so this is only a sanity bound. */
export const MAX_QUOTED_PROMPT_CHARS = 1000;

/** The shape correct-and-retry needs off the quest being corrected. */
export type CorrectedTurn = {
  prompt?: string;
  reply?: string | null;
  replies?: string[];
  structuredReplies?: Array<{ role?: string; content?: MessageContentObject[] } | null | undefined> | null;
};

/**
 * The two halves of the framing, kept apart so they can be ranked apart. Keys are PromptSourceIds so
 * this drops straight into buildTaggedContextMessages' MessagesBySource.
 */
export type CorrectionContextMessages = {
  /** The instruction: this message is a critique, re-answer it. Cheap, and the load-bearing half. */
  correction: IMessage[];
  /** The quoted request and answer. Up to MAX_QUOTED_* characters, and droppable under budget. */
  correctionQuote: IMessage[];
};

const noCorrection = (): CorrectionContextMessages => ({ correction: [], correctionQuote: [] });

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[...truncated]`;
}

/**
 * The prose an assistant turn actually said, ignoring tool_use/thinking/image blocks.
 *
 * Assistant entries only. `role` is `required: true` on each entry (QuestModel.ts:467), and a
 * `user`-role entry carries tool_result content rather than anything the model said - quoting that
 * back as "the answer they are correcting" would be wrong.
 */
function readStructuredText(turn: CorrectedTurn): string {
  const blocks = (turn.structuredReplies ?? [])
    .filter(entry => entry?.role === 'assistant')
    .flatMap(entry => entry?.content ?? []);
  return blocks
    .map(block => (block?.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * The answer as prose, in the same precedence the other readers of this shape use.
 *
 * IMPORTANT: `structuredReplies` is NOT written by anything in core today - see
 * `b4m-core/utils/src/llm/utils.ts:556`, "Priority 1 (`structuredReplies`) still never fires
 * (nothing writes that field)". The branch is kept because it is the precedence the siblings
 * already declare (utils.ts:356, publish/reply.ts:42, questTimeoutRecovery.ts:68) and costs nothing
 * while the field stays empty, so a writer appearing later does not silently strand this reader.
 * It is dead code until then, and should be read as such.
 *
 * Unlike estimateQuestTokenLength, which stops at `structuredReplies?.length`, this falls THROUGH
 * when the structured blocks carry no text: that function wants a size estimate, this one wants
 * prose to quote. `replies` is the multi-part form and `reply` the single-string form kept for
 * older turns. None is guaranteed, so this can legitimately come back empty.
 *
 * If a writer does appear, two things need revisiting with it: the retry path at
 * ChatCompletionInvoke.ts clears `reply`/`replies` but not `structuredReplies`, so a retried turn
 * would be quoted from its pre-retry answer; and toolResults pairing lives in a sibling field.
 */
export function readAnswerText(turn: CorrectedTurn): string {
  const fromStructured = readStructuredText(turn);
  if (fromStructured) return fromStructured;
  const fromReplies = turn.replies?.filter(Boolean).join('\n').trim();
  if (fromReplies) return fromReplies;
  return turn.reply?.trim() ?? '';
}

/**
 * Frames a correct-and-retry turn for the model: names the answer being corrected, and says the
 * user's latest message is a critique of it rather than a new question.
 *
 * Returns empty lists when there is nothing to correct against - a turn whose answer was never
 * recorded (still running, errored, stopped) gives the model no referent, and a framing that quotes
 * an empty answer invites it to invent what it supposedly said. The turn then proceeds as an
 * ordinary one, which is the honest degradation: the user's correction text is still their message.
 *
 * The two messages are written to stand alone, because under budget pressure the quote is dropped
 * and the instruction is kept.
 */
export function buildCorrectionContextMessages(
  correctedTurn: CorrectedTurn | null | undefined
): CorrectionContextMessages {
  if (!correctedTurn) return noCorrection();

  const answer = readAnswerText(correctedTurn);
  if (!answer) return noCorrection();

  const request = correctedTurn.prompt?.trim();
  const requestBlock = request
    ? `The request it was answering was:\n"""\n${truncate(request, MAX_QUOTED_PROMPT_CHARS)}\n"""\n\n`
    : '';

  return {
    correction: [
      {
        role: 'system' as const,
        content:
          `The user's latest message is a CORRECTION of an earlier answer of yours, not a new question.\n\n` +
          `Treat their message as a statement of what was wrong with that answer. Produce a corrected ` +
          `answer to the original request, applying their correction. Do not restate the flawed answer, ` +
          `and do not reply with only an apology or an acknowledgement - the user is asking to be ` +
          `answered again, correctly. If their correction is itself mistaken, say so plainly and explain ` +
          `why rather than adopting it.`,
      },
    ],
    correctionQuote: [
      {
        role: 'system' as const,
        content:
          `${requestBlock}` +
          `The answer they are correcting was:\n"""\n${truncate(answer, MAX_QUOTED_ANSWER_CHARS)}\n"""`,
      },
    ],
  };
}

/** Just enough of the quest store to read the corrected turn back. */
export type CorrectionQuestReader = {
  /**
   * `sessionId` is deliberately NOT optional: it is `required: true` (QuestModel.ts:444) and
   * `findById` applies no projection today, so declaring it required makes a future narrowing
   * projection that drops the field fail the typecheck rather than the session gate below.
   */
  findById: (id: string) => Promise<(CorrectedTurn & { sessionId: string }) | null | undefined>;
};

/**
 * Resolve the persisted `correctsQuestId` link into framing messages.
 *
 * Reads off the PERSISTED quest rather than the request body: ChatCompletionInvoke binds the link to
 * the caller's session before writing it, so trusting the document keeps that one check
 * authoritative instead of re-deriving trust from a field the caller controls.
 *
 * The session re-check is not redundant with it. A session copy (clone/fork/snip) writes messages
 * into a NEW session, so a link bound at invoke time names a quest in the source session once the
 * turn has been copied. Those paths strip the field now, but access is checked when you copy and not
 * when the pointer is later dereferenced - so this is the gate that stops a stale pointer turning
 * into quoted content from another session, rather than depending on every writer having got it
 * right. Must stay in sync with the strip in sessionService clone.ts/fork.ts/snip.ts.
 */
export async function resolveCorrectionContext(
  quest: { correctsQuestId?: string | null; sessionId?: string | null },
  quests: CorrectionQuestReader,
  logger: { warn: (message: string) => void }
): Promise<CorrectionContextMessages> {
  if (!quest.correctsQuestId) return noCorrection();

  const correctedTurn = await quests.findById(quest.correctsQuestId);

  // Positive check, not reject-on-mismatch: two absent ids compare unequal-false and would let the
  // link through. Nothing can produce that today, but a narrowed read is the obvious next change
  // here, and this gate failing open is the one outcome it must not have.
  if (correctedTurn && !(correctedTurn.sessionId && quest.sessionId && correctedTurn.sessionId === quest.sessionId)) {
    logger.warn(
      `🔁 [CORRECTION] Ignoring cross-session correction link: quest ${quest.correctsQuestId} belongs to ` +
        `session ${correctedTurn.sessionId}, not ${quest.sessionId}.`
    );
    return noCorrection();
  }

  const messages = buildCorrectionContextMessages(correctedTurn);
  // The turn still runs, so this degradation is invisible from the outside - it is only ever legible
  // here. Both causes are recoverable states (the corrected turn was deleted, or it errored before
  // recording an answer), not bugs, so a warn rather than a throw.
  if (messages.correction.length === 0) {
    logger.warn(
      `🔁 [CORRECTION] Sending turn without correction framing: quest ${quest.correctsQuestId} is ${
        correctedTurn ? 'missing a recorded answer' : 'gone'
      }`
    );
  }
  return messages;
}
