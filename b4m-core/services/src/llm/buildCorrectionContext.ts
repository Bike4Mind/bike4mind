import type { IMessage } from '@bike4mind/common';

/**
 * How much of the flagged answer is quoted back. A corrected answer is often long, and the point of
 * the quote is to identify WHICH answer is being corrected - the model still has the full turn in
 * conversation history when it is recent enough to be in the window. Truncation is announced rather
 * than silent so the model does not treat the tail as the end of what it said.
 */
export const MAX_QUOTED_ANSWER_CHARS = 4000;

/** Same, for the request that produced it; prompts are far shorter, so this is only a sanity bound. */
export const MAX_QUOTED_PROMPT_CHARS = 1000;

/** The shape correct-and-retry needs off the quest being corrected. */
export type CorrectedTurn = {
  prompt?: string;
  reply?: string | null;
  replies?: string[];
};

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[...truncated]`;
}

/**
 * The answer as prose. `replies` is the canonical multi-part form (see estimateQuestTokenLength in
 * @bike4mind/utils, which reconstructs history the same way); `reply` is the single-string form kept
 * for older turns. Neither is guaranteed, so this can legitimately come back empty.
 */
function readAnswerText(turn: CorrectedTurn): string {
  const fromReplies = turn.replies?.filter(Boolean).join('\n').trim();
  if (fromReplies) return fromReplies;
  return turn.reply?.trim() ?? '';
}

/**
 * Frames a correct-and-retry turn for the model: names the answer being corrected, and says the
 * user's latest message is a critique of it rather than a new question.
 *
 * Returns [] when there is nothing to correct against - a turn whose answer was never recorded
 * (still running, errored, stopped) gives the model no referent, and a framing that quotes an empty
 * answer invites it to invent what it supposedly said. The turn then proceeds as an ordinary one,
 * which is the honest degradation: the user's correction text is still their message.
 */
export function buildCorrectionContextMessages(correctedTurn: CorrectedTurn | null | undefined): IMessage[] {
  if (!correctedTurn) return [];

  const answer = readAnswerText(correctedTurn);
  if (!answer) return [];

  const request = correctedTurn.prompt?.trim();
  const requestBlock = request
    ? `The request it was answering was:\n"""\n${truncate(request, MAX_QUOTED_PROMPT_CHARS)}\n"""\n\n`
    : '';

  return [
    {
      role: 'system' as const,
      content:
        `The user's latest message is a CORRECTION of an earlier answer of yours, not a new question.\n\n` +
        `${requestBlock}` +
        `The answer they are correcting was:\n"""\n${truncate(answer, MAX_QUOTED_ANSWER_CHARS)}\n"""\n\n` +
        `Treat their message as a statement of what was wrong with that answer. Produce a corrected ` +
        `answer to the original request, applying their correction. Do not restate the flawed answer, ` +
        `and do not reply with only an apology or an acknowledgement - the user is asking to be ` +
        `answered again, correctly. If their correction is itself mistaken, say so plainly and explain ` +
        `why rather than adopting it.`,
    },
  ];
}
