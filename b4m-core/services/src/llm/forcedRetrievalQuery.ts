/** How many earlier user turns a follow-up may borrow its subject from, and how much of each. */
export const FORCED_RETRIEVAL_PRIOR_TURNS = 2;
export const FORCED_RETRIEVAL_PRIOR_TURN_CHARS = 300;

/** At or under this many words a message is treated as a follow-up whatever its wording. */
export const FORCED_RETRIEVAL_FOLLOW_UP_MAX_WORDS = 12;

/** Weight of the earlier turns in the blended query vector. 0.5 was chosen on a small synthetic corpus. */
export const FORCED_RETRIEVAL_CONTEXT_WEIGHT = 0.5;

// Words that point back at something said earlier. English only.
//
// The gate below is deliberately broad and is near-always-on in practice, not the narrow "short or
// pointing back" reading it is easy to take from the name: any message carrying one of these words
// blends whatever its length, and a script written without spaces (Japanese, Chinese, Thai) counts as
// a single word, so every such message qualifies. The extra embedding is bounded per turn and cannot
// starve one - a chunk the bare message alone would have admitted still clears the floor (see the
// blended/bare admission in KnowledgeRetrievalFeature) - so the breadth costs an embedding call, not
// recall. Tightening it would need a language-aware tokenizer; see looksLikeFollowUp.
const REFERRING_WORD =
  /\b(it|its|they|them|their|theirs|that|this|those|these|he|she|him|his|her|hers|former|latter)\b/i;

// A server-authored quest prompt, not something the user typed: the proactive-messaging service stores
// "[Proactive message from <agent>]" as the prompt and puts the real content in its reply. It carries
// no subject to borrow, so feeding it to a follow-up only adds a direction the question is not about.
// Bracket-only user turns are rare enough that dropping one costs a sliver of context, not an answer.
const SERVER_AUTHORED_PROMPT = /^\[.*\]$/;

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
 * session's first turn is still in its own history. Server-authored placeholder prompts are skipped:
 * they name no subject and their content lives in the reply this context does not read.
 *
 * Known gap: LakeMemoryFeature recalls beliefs with the bare `query` in the same turn, so a pronoun
 * can resolve to different subjects across the two surfaces. Sharing this helper is the fix; until
 * then only the forced chunk retrieval reads the follow-up subject from here.
 */
export function forcedRetrievalFollowUpContext(
  message: string,
  priorUserPrompts: readonly string[] | undefined
): { context: string; priorTurnsUsed: number } | undefined {
  const current = message.trim();
  const prior = (priorUserPrompts ?? [])
    .map(p => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .filter(p => !SERVER_AUTHORED_PROMPT.test(p));
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
