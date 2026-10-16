/** How many earlier user turns a follow-up may borrow its subject from, and how much of each. */
export const FORCED_RETRIEVAL_PRIOR_TURNS = 2;
export const FORCED_RETRIEVAL_PRIOR_TURN_CHARS = 300;

/** At or under this many words a message is treated as a follow-up whatever its wording. */
export const FORCED_RETRIEVAL_FOLLOW_UP_MAX_WORDS = 12;

/** Weight of the earlier turns in the blended query vector. 0.5 was chosen on a small synthetic corpus. */
export const FORCED_RETRIEVAL_CONTEXT_WEIGHT = 0.5;

// Words that point back at something said earlier. English only: a message in another language
// still qualifies through the word count, and one that qualifies through neither is embedded as-is.
const REFERRING_WORD =
  /\b(it|its|they|them|their|theirs|that|this|those|these|he|she|him|his|her|hers|former|latter)\b/i;

/** Whether `message` probably leans on the conversation for its subject. */
export function looksLikeFollowUp(message: string): boolean {
  const words = message.trim().split(/\s+/).filter(Boolean);
  return words.length <= FORCED_RETRIEVAL_FOLLOW_UP_MAX_WORDS || REFERRING_WORD.test(message);
}

/**
 * The conversation text a follow-up should be retrieved with, or undefined when the message is
 * embedded on its own. A follow-up such as "what about their pricing?" names nothing, so alone it
 * scores every pricing passage in the corpus alike. The last few user turns, clipped, give it back
 * its subject without a model call.
 *
 * `priorUserPrompts` is oldest first. A trailing copy of the current message is ignored, because a
 * session's first turn is still in its own history.
 */
export function forcedRetrievalFollowUpContext(
  message: string,
  priorUserPrompts: readonly string[] | undefined
): { context: string; priorTurnsUsed: number } | undefined {
  const current = message.trim();
  const prior = (priorUserPrompts ?? []).map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);
  while (prior.length > 0 && prior[prior.length - 1] === current) prior.pop();
  if (!current || prior.length === 0 || !looksLikeFollowUp(current)) return undefined;

  const window = prior.slice(-FORCED_RETRIEVAL_PRIOR_TURNS).map(p => p.slice(0, FORCED_RETRIEVAL_PRIOR_TURN_CHARS));
  return { context: window.join('\n'), priorTurnsUsed: window.length };
}

const unitVector = (v: readonly number[]): number[] | undefined => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 && Number.isFinite(norm) ? v.map(x => x / norm) : undefined;
};

/**
 * Unit-length `message + weight * context`, both taken at unit length first so a long earlier turn
 * cannot outweigh the question. Embedding the two separately is what keeps the current message in
 * charge: a concatenated string lets whichever text is longer set the direction. Falls back to the
 * message vector when the two cannot be combined.
 */
export function blendFollowUpQueryVector(
  messageVector: number[],
  contextVector: readonly number[],
  weight: number = FORCED_RETRIEVAL_CONTEXT_WEIGHT
): number[] {
  if (contextVector.length !== messageVector.length) return messageVector;
  const m = unitVector(messageVector);
  const c = unitVector(contextVector);
  if (!m || !c) return messageVector;
  return unitVector(m.map((x, i) => x + weight * c[i])) ?? messageVector;
}
