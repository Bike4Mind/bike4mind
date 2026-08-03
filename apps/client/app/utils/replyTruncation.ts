// Derives how a completed assistant reply should be framed when the model stopped against
// the output-token ceiling. Lives outside PromptReplies.tsx so the rules are unit-testable
// without mounting the whole reply renderer.

/**
 * Provider stop reasons that mean the model finished its turn normally (vs being cut off at
 * the output-token ceiling). Values are the normalized vocabulary produced by
 * `@bike4mind/llm-adapters` stopReason.ts - must stay in sync with it.
 */
export const CLEAN_FINISH_REASONS = new Set(['end_turn', 'stop', 'tool_use', 'stop_sequence']);

/** Normalized stop reason for "generation was cut off at the output-token limit". */
const TRUNCATED_FINISH_REASON = 'max_tokens';

/**
 * Which truncation notice (if any) to render. Exactly one at a time:
 *  - 'artifact': cut off mid-artifact, the partial is best-effort recovered into a card.
 *  - 'reply-partial': cut off in prose, some content survived.
 *  - 'reply-empty': cut off before producing any content, so the bubble would be blank.
 */
export type ReplyTruncationNotice = 'artifact' | 'reply-partial' | 'reply-empty' | null;

export interface ReplyTruncationInput {
  /** Reply text with <think> blocks already stripped. */
  reply: string;
  /** Quest reached status 'done'. */
  completed: boolean;
  /** `promptMeta.finishReason` - the provider stop reason, absent on older quests. */
  finishReason?: string;
}

export interface ReplyTruncationState {
  /** An artifact is still opening while the reply streams - hide the partial to avoid flicker. */
  isStreamingArtifact: boolean;
  /** Completed with an unclosed artifact - contain the partial instead of leaking raw HTML. */
  isTruncatedArtifact: boolean;
  notice: ReplyTruncationNotice;
}

export function getReplyTruncationState({
  reply,
  completed,
  finishReason,
}: ReplyTruncationInput): ReplyTruncationState {
  // Compare open/close tag counts rather than a bare substring check so a reply that emits one
  // CLOSED artifact followed by a second UNCLOSED one is still detected (a substring check
  // would see the lone </artifact> and miss the dangling tag).
  const opens = reply ? (reply.match(/<artifact\b/gi) || []).length : 0;
  const closes = reply ? (reply.match(/<\/artifact>/gi) || []).length : 0;
  const hasUnclosedArtifact = opens > closes;

  // A clean stop reason means an unclosed `<artifact` is a prose mention, not truncation - the
  // artifact system prompt makes such mentions likely, and mangling one into a card is worse
  // than ignoring it. An ABSENT reason (older quests, backends that don't report one) still
  // falls through to containment so raw HTML can never leak into the bubble.
  const finishedCleanly = !!finishReason && CLEAN_FINISH_REASONS.has(finishReason);

  const isStreamingArtifact = hasUnclosedArtifact && !completed;
  const isTruncatedArtifact = hasUnclosedArtifact && completed && !finishedCleanly;

  let notice: ReplyTruncationNotice = null;
  if (isTruncatedArtifact) {
    notice = 'artifact';
  } else if (completed && !hasUnclosedArtifact && finishReason === TRUNCATED_FINISH_REASON) {
    // Deliberately requires an EXPLICIT max_tokens: unlike the artifact path above, a missing
    // finishReason must not surface a notice or every pre-existing quest grows a false banner.
    notice = reply.trim() ? 'reply-partial' : 'reply-empty';
  }

  return { isStreamingArtifact, isTruncatedArtifact, notice };
}
