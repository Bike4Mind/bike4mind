import { detectSkillMentions, type IMessage } from '@bike4mind/common';

/**
 * Blog intent in the message itself. Deliberately narrow: bare `post`/`publish`/`article` fire on
 * ordinary chat, so a word-boundary match on `blog` and its close relatives is the whole gate.
 * Verified against the one product surface that depends on the auto-add today - the Content
 * Publishing Studio's prompt is literally "Transform this conversation into a blog post." - so this
 * pattern covers it verbatim.
 */
export const BLOG_REQUEST_PATTERN = /\b(?:blog|blogs|blogging|blogged|blogpost|substack|wordpress|ghost\s+cms)\b/i;

const BLOG_TOOL_NAMES = ['blog_draft', 'blog_publish', 'blog_edit'];

/**
 * True when an earlier turn in this conversation already used one of `toolNames`. Scanned off the
 * verbatim history window already loaded for this turn - no extra DB query - so a natural follow-up
 * ("now publish it") that would not itself match a message-level intent pattern still gets the tool:
 * without this, a multi-turn blog/skill workflow would silently lose the tool mid-conversation, which
 * is the feature-loss the "no degradation" guardrail forbids.
 */
export function hasPriorToolUse(previousMessages: readonly IMessage[], toolNames: readonly string[]): boolean {
  return previousMessages.some(
    message =>
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      (message.content as Array<{ type?: string; name?: string }>).some(
        block => block.type === 'tool_use' && toolNames.includes(block.name ?? '')
      )
  );
}

/**
 * Whether each blog tool should be offered this turn. Keeps the existing isAdmin/hasBlogIntegration
 * requirements unchanged and ANDs the intent-or-continuation check onto each, so a non-admin or a
 * non-integrated admin sees no behavior change at all.
 */
export function shouldOfferBlogTools(input: {
  isAdmin: boolean;
  hasBlogIntegration: boolean;
  message: string;
  previousMessages: readonly IMessage[];
}): { draft: boolean; publish: boolean; edit: boolean } {
  const intentOrContinuation =
    BLOG_REQUEST_PATTERN.test(input.message) || hasPriorToolUse(input.previousMessages, BLOG_TOOL_NAMES);
  return {
    draft: input.isAdmin && intentOrContinuation,
    publish: input.isAdmin && input.hasBlogIntegration && intentOrContinuation,
    edit: input.isAdmin && input.hasBlogIntegration && intentOrContinuation,
  };
}

/**
 * Whether the `skill` tool should be offered this turn. `invocableSkillCount` is the honest gate: a
 * user with zero invocable skills gets a tool whose every call returns "you have no LLM-invocable
 * skills defined" today, with no catalog in the prompt to name one - offering it costs tokens for a
 * call that can never succeed. `hasSkillInvocation` and the prior-turn check rescue the two cases a
 * bare catalog count misses: an explicit `/skill-name` attempt (possibly for a shared/org skill not
 * in this user's own catalog), and a natural follow-up continuing a skill invoked earlier this turn.
 */
export function shouldOfferSkillTool(input: {
  hasSkillRepository: boolean;
  invocableSkillCount: number;
  message: string;
  previousMessages: readonly IMessage[];
}): boolean {
  if (!input.hasSkillRepository) return false;
  if (input.invocableSkillCount > 0) return true;
  // Lowercased because the mention regex requires a lowercase kebab-case name (SkillModel's own
  // constraint) - this only widens what counts as "an attempt", never what SkillsFeature itself
  // resolves, so a case-mismatched slash command still fails to invoke; it just does not also lose
  // the tool that could explain why.
  if (detectSkillMentions(input.message.toLowerCase()).length > 0) return true;
  return hasPriorToolUse(input.previousMessages, ['skill']);
}
