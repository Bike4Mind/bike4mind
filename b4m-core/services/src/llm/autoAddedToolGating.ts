import { DATA_LAKE_TOOL_NAMES, detectAgentMentions, detectSkillMentions } from '@bike4mind/common';

/**
 * Blog intent in the message itself. Two branches: a word-boundary match on `blog` and its close
 * relatives (deliberately narrow - bare `post`/`publish`/`article` fire on ordinary chat), OR the
 * Content Publishing Studio's own structural phrasing, "transform this conversation into a X
 * post" - matched by shape rather than a hardcoded format list, so it covers all of the Studio's
 * `OutputFormat` values (`blog`/`linkedin`/`twitter`/`newsletter`) including ones the client UI
 * does not expose yet (the three non-blog radios render `disabled` today - "Coming Soon" - but the
 * server-side `blog_draft` schema already accepts all four, and the client will presumably enable
 * them without a corresponding server change). The first version of this pattern matched only the
 * `blog` word and missed the other three formats - a human review caught it before any client-side
 * enablement made it a live regression.
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
export const BLOG_REQUEST_PATTERN =
  /\b(?:blog|blogs|blogging|blogged|blogpost|substack|wordpress|ghost\s+cms)\b|transform\s+this\s+conversation\s+into\s+a\s+\S+\s+post\b/i;

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
 * Data-lake intent: the product term itself ("data lake", "data-lakes"), a save-style verb shortly
 * followed by "to/into/in ... lake", a create request ("create a lake called Q3"), or a list
 * request ("list my lakes", "what lakes do I have"). All case-insensitive; place names are cut out
 * first instead (PLACE_NAME_PATTERN), so "save the photos from our trip to Lake Tahoe" stays quiet.
 * A false positive only costs the offer - every tool still checks the flag and the caller's access.
 */
const PLACE_NAME_PATTERN = /\bLakes?\s+[A-Z][\w-]*/g;
const DATA_LAKE_MENTION_PATTERN = /\bdata[\s-]?lakes?\b/i;
const SAVE_TO_LAKE_PATTERN =
  /\b(?:save|store|upload|archive|add|put|file|move|copy)\b[^.?!\n]{0,80}?\b(?:to|into|in)\s+(?:(?:my|our|your|the|a|an|this|that|new|one)\s+){0,2}(?:[\w-]+\s+){0,2}lakes?\b/i;
const CREATE_LAKE_PATTERN =
  /\b(?:create|make|set\s+up)\s+(?:me\s+)?(?:(?:a|an|another|one)\s+)?(?:new\s+)?(?:[\w-]+\s+)?lake\b/i;
const LIST_LAKES_PATTERN =
  /\b(?:list|show)\s+(?:me\s+)?(?:all\s+)?(?:of\s+)?(?:my|our)\s+lakes\b|\b(?:what|which)\s+lakes\s+(?:do|can|have)\s+(?:i|we)\b/i;

export function mentionsDataLakeSave(message: string): boolean {
  if (DATA_LAKE_MENTION_PATTERN.test(message)) return true;
  const withoutPlaceNames = message.replace(PLACE_NAME_PATTERN, ' ');
  return [SAVE_TO_LAKE_PATTERN, CREATE_LAKE_PATTERN, LIST_LAKES_PATTERN].some(pattern =>
    pattern.test(withoutPlaceNames)
  );
}

/**
 * Whether the save-to-data-lake tools should be offered this turn: intent in the message or a
 * continuation of an earlier save, AND the EnableDataLakes platform flag. The flag is a thunk so
 * the ordinary turn (no intent) never pays for the settings read.
 */
export async function shouldOfferDataLakeTools(input: {
  message: string;
  priorToolNames: readonly string[];
  dataLakesEnabled: () => Promise<boolean>;
}): Promise<boolean> {
  const intentOrContinuation =
    mentionsDataLakeSave(input.message) || hasPriorToolUse(input.priorToolNames, DATA_LAKE_TOOL_NAMES);
  return intentOrContinuation && (await input.dataLakesEnabled());
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

/**
 * Normalizes an agent handle for comparison. `ServerAgentStore` names its built-ins with
 * underscores (`code_review`, `github_manager`) while the mention parser accepts hyphens too, so
 * `@code-review` must resolve to `code_review` rather than silently dropping delegation.
 */
function normalizeAgentHandle(handle: string): string {
  return handle.toLowerCase().replace(/-/g, '_');
}

/**
 * True when this turn's message @-mentions an agent that the delegation store can actually run.
 *
 * The previous gate was "the message contains any @mention at all", which fired on every
 * `@teammate`, pasted social handle, or `@here` in ordinary prose - attaching the
 * `delegate_to_agent` schema (~786 tokens, measured against the provider tokenizer) plus the
 * agent-directory section of the tool prompt to chats that had no delegatable target, and
 * re-opening the self-delegation side-channel that gating this tool was meant to close.
 *
 * A mention that resolves to a *persona* agent (the `agents` collection, matched by trigger word
 * in AgentDetectionFeature) is deliberately NOT a delegation signal: personas are applied as a
 * system prompt, and `delegate_to_agent`'s `agent` enum only ever contains the store's own
 * definitions, so offering the tool for them would name a target it cannot reach.
 */
export function mentionsDelegatableAgent(message: string, delegatableAgentNames: readonly string[]): boolean {
  const mentions = detectAgentMentions(message);
  if (mentions.length === 0) return false;
  const delegatable = new Set(delegatableAgentNames.map(normalizeAgentHandle));
  return mentions.some(mention => delegatable.has(normalizeAgentHandle(mention)));
}

/**
 * Whether `delegate_to_agent` should be offered on this chat turn.
 *
 * Delegation is opt-in: without a signal the model would auto-delegate on benign prompts and burn
 * subagent runs the user never asked for. A hard veto plus three opt-in signals, cheap-first:
 *   - `disableUserIntegrations` hard-vetoes everything (a curated surface must never delegate);
 *   - an explicit `allowedAgents` allowlist from the caller (persona surfaces scoping the set) -
 *     an *empty* allowlist means "no delegation requested", not "delegation to nothing";
 *   - an agent attached to the session via the UI;
 *   - an @mention naming an agent this store can actually run.
 *
 * Deliberately NO prior-turn continuation rescue, unlike the blog and skill gates above. Those
 * rescue a cheap tool whose worst case is a wasted schema; this one would re-arm autonomous
 * subagent spawning for the rest of a conversation off a single earlier delegation, which is the
 * expensive failure mode the gate exists to prevent (one such run rolled up ~18k credits). A
 * multi-turn delegated workflow is instead carried by `session.agentIds`, which
 * AgentDetectionFeature persists for every summon that resolves to a real agent.
 */
export function shouldOfferDelegation(input: {
  disableUserIntegrations: boolean;
  allowedAgents: readonly string[] | undefined;
  sessionAgentIds: readonly string[] | undefined;
  message: string;
  delegatableAgentNames: readonly string[];
}): boolean {
  if (input.disableUserIntegrations) return false;
  if ((input.allowedAgents?.length ?? 0) > 0) return true;
  if ((input.sessionAgentIds?.length ?? 0) > 0) return true;
  return mentionsDelegatableAgent(input.message, input.delegatableAgentNames);
}
