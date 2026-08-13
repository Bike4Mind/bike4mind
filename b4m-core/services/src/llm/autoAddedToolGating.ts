import { detectSkillMentions } from '@bike4mind/common';

/**
 * Blog intent in the message itself. Deliberately narrow: bare `post`/`publish`/`article` fire on
 * ordinary chat, so a word-boundary match on `blog` and its close relatives is the whole gate.
 * Verified against the one product surface found to PROACTIVELY SEND a message expecting a blog
 * tool without the user's own wording naming it - the Content Publishing Studio's prompt is
 * literally "Transform this conversation into a blog post." - so this pattern covers it verbatim.
 * (Other blog_draft/publish/edit references in the client are consumers of the tool's result -
 * an artifact renderer, a preview card, a Settings help string - not message-sending triggers.)
 *
 * Overlaps the client's own `/blog-publish`/`/blog-update` slash commands (SlashCommandSuggestions.tsx),
 * which also satisfy the skill-mention rescue below (any `/kebab-case` token does) - a session with
 * an empty skill catalog gets `skill` attached alongside the correctly-triggered blog tools on that
 * turn. Accepted: the turn is already paying for extra tools for a real reason, and narrowing the
 * skill rescue to exclude specific command names would couple this module to the client's slash
 * command list.
 */
export const BLOG_REQUEST_PATTERN = /\b(?:blog|blogs|blogging|blogged|blogpost|substack|wordpress|ghost\s+cms)\b/i;

const BLOG_TOOL_NAMES = ['blog_draft', 'blog_publish', 'blog_edit'];

/**
 * True when an earlier turn in this conversation already used one of `toolNames`. `priorToolNames`
 * comes from `fetchAndProcessPreviousMessages`'s own field of that name, read off each turn's raw
 * `promptMeta.functionCalls` - NOT derived from scanning the reconstructed IMessage history, which
 * cannot answer this (see that field's doc comment in utils.ts: neither of the two tool_use-replay
 * paths there fires in production today). Without this, a multi-turn blog/skill workflow would
 * silently lose the tool the moment a follow-up message stops repeating the trigger word, which is
 * the feature-loss the "no degradation" guardrail forbids.
 *
 * Bounded by whatever window `priorToolNames` was built from (the verbatim history + context-summary
 * boundary already applied upstream) - a tool used long enough ago to fall outside that window will
 * not be found. Accepted: re-deriving continuation from the full conversation would need a dedicated
 * query, which is disproportionate to what this ticket is trying to save.
 */
export function hasPriorToolUse(priorToolNames: readonly string[], toolNames: readonly string[]): boolean {
  return priorToolNames.some(name => toolNames.includes(name));
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
  priorToolNames: readonly string[];
}): { draft: boolean; publish: boolean; edit: boolean } {
  // Checked first so the regex/continuation check below never runs for the common non-admin turn.
  if (!input.isAdmin) return { draft: false, publish: false, edit: false };

  const intentOrContinuation =
    BLOG_REQUEST_PATTERN.test(input.message) || hasPriorToolUse(input.priorToolNames, BLOG_TOOL_NAMES);
  return {
    draft: intentOrContinuation,
    publish: input.hasBlogIntegration && intentOrContinuation,
    edit: input.hasBlogIntegration && intentOrContinuation,
  };
}

/**
 * Whether the `skill` tool should be offered this turn. `invocableSkillCount` is the honest gate: a
 * user with zero invocable skills gets a tool whose every call returns "you have no LLM-invocable
 * skills defined" today, with no catalog in the prompt to name one - offering it costs tokens for a
 * call that can never succeed. The slash-mention check (`detectSkillMentions`) and the prior-turn
 * check rescue the two cases a bare catalog count misses: an explicit `/skill-name` attempt (a typo
 * or a reference the user's catalog does not resolve, so the tool can at least report why), and a
 * natural follow-up continuing a skill invoked earlier this conversation.
 */
export function shouldOfferSkillTool(input: {
  hasSkillRepository: boolean;
  invocableSkillCount: number;
  message: string;
  priorToolNames: readonly string[];
}): boolean {
  if (!input.hasSkillRepository) return false;
  if (input.invocableSkillCount > 0) return true;
  // Lowercased because the mention regex requires a lowercase kebab-case name (SkillModel's own
  // constraint) - this only widens what counts as "an attempt", never what SkillsFeature itself
  // resolves, so a case-mismatched slash command still fails to invoke; it just does not also lose
  // the tool that could explain why.
  if (detectSkillMentions(input.message.toLowerCase()).length > 0) return true;
  return hasPriorToolUse(input.priorToolNames, ['skill']);
}
