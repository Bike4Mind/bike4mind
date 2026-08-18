import { detectAgentMentions, detectSkillMentions } from '@bike4mind/common';

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

const DELEGATE_TOOL_NAMES = ['delegate_to_agent'];

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
 * subagent runs the user never asked for. A hard veto plus four opt-in signals, cheap-first:
 *   - `disableUserIntegrations` hard-vetoes everything (a curated surface must never delegate);
 *   - an explicit `allowedAgents` allowlist from the caller (persona surfaces scoping the set) -
 *     an *empty* allowlist means "no delegation requested", not "delegation to nothing";
 *   - an agent attached to the session via the UI;
 *   - an @mention naming an agent this store can actually run;
 *   - a `delegate_to_agent` call earlier in this conversation, so a multi-turn delegated workflow
 *     does not lose the tool the moment a follow-up stops repeating the @mention (same
 *     continuation rescue, and the same history-window bound, as `hasPriorToolUse` above).
 */
export function shouldOfferDelegation(input: {
  disableUserIntegrations: boolean;
  allowedAgents: readonly string[] | undefined;
  sessionAgentIds: readonly string[] | undefined;
  message: string;
  delegatableAgentNames: readonly string[];
  priorToolNames: readonly string[];
}): boolean {
  if (input.disableUserIntegrations) return false;
  if ((input.allowedAgents?.length ?? 0) > 0) return true;
  if ((input.sessionAgentIds?.length ?? 0) > 0) return true;
  if (mentionsDelegatableAgent(input.message, input.delegatableAgentNames)) return true;
  return hasPriorToolUse(input.priorToolNames, DELEGATE_TOOL_NAMES);
}
