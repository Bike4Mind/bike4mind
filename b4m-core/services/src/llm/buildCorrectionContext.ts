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
  structuredReplies?: Array<{ content?: MessageContentObject[] } | null | undefined> | null;
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

/** The prose an assistant turn actually said, ignoring tool_use/thinking/image blocks. */
function readStructuredText(turn: CorrectedTurn): string {
  const blocks = (turn.structuredReplies ?? []).flatMap(entry => entry?.content ?? []);
  return blocks
    .map(block => (block?.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * The answer as prose. `structuredReplies` is preferred because a tool-using or thinking-format turn
 * records its text there and can leave `replies`/`reply` empty - the same precedence
 * estimateQuestTokenLength uses (@bike4mind/utils, utils.ts), and the same reason the publish and
 * timeout-recovery readers flatten it. Unlike that function this falls THROUGH when the structured
 * blocks carry no text (a turn that only called tools), because what is wanted here is prose to
 * quote rather than a size estimate. `replies` is the multi-part form and `reply` the single-string
 * form kept for older turns. None is guaranteed, so this can legitimately come back empty.
 */
function readAnswerText(turn: CorrectedTurn): string {
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
  findById: (id: string) => Promise<(CorrectedTurn & { sessionId?: string }) | null | undefined>;
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

  if (correctedTurn && correctedTurn.sessionId !== quest.sessionId) {
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
