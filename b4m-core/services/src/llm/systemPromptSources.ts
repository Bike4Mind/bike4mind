import { IMessage, SystemPromptDetailSchema } from '@bike4mind/common';
import type { z } from 'zod';
import type { featureNames } from './ChatCompletionFeatures';

/**
 * The system/context stack a completion is assembled from, as data rather than as an inline array
 * literal.
 *
 * Extracted from ChatCompletionProcess because that array had three consumers drifting apart: the
 * prompt itself, the telemetry breakdown (which was a hand-maintained second list, already missing
 * most sources and naming a `session.summary` entry the prompt never carried), and - once the API
 * gains a prompt mode - a caller-facing filter. Tagging each message with the source that produced
 * it lets all three read the same list.
 *
 * Note this is not the whole stack: `buildAndSortMessages` appends the FormatPromptTemplate and
 * image-prompt system messages further downstream, so anything auditing "what did the model
 * actually see" must account for those too. Must stay in sync with the assembly in
 * ChatCompletionProcess.
 *
 * Pure: no I/O, no mutation of its inputs.
 */

export type PromptSourceId =
  | 'dateContext'
  | 'extraContext'
  | 'artifactEmission'
  | 'helpCenter'
  | 'abstention'
  | 'viewRegistry'
  | 'toolPrompt'
  | 'agentDetection'
  | 'questMaster'
  | 'organizationPrompt'
  | 'sessionPrompt'
  | 'skills'
  | 'knowledgeRetrieval'
  | 'contextSummary'
  | 'mementos'
  | 'project'
  | 'recentImages'
  | 'urls'
  | 'attachedFiles';

/**
 * Assembly order, and the single place it is defined. Order is prompt-visible - the Anthropic
 * caching adapter marks the last system block, so everything ahead of it forms the cached prefix -
 * so changing this table changes both behavior and cache hit rate.
 */
export const PROMPT_SOURCE_ORDER: PromptSourceId[] = [
  'dateContext',
  'extraContext',
  'artifactEmission',
  'helpCenter',
  'abstention',
  'viewRegistry',
  'toolPrompt',
  'agentDetection',
  'questMaster',
  'organizationPrompt',
  'sessionPrompt',
  'skills',
  'knowledgeRetrieval',
  'contextSummary',
  'mementos',
  'project',
  'recentImages',
  'urls',
  'attachedFiles',
];

export interface TaggedSystemMessage {
  source: PromptSourceId;
  message: IMessage;
}

/** Messages each source contributed this turn. A source with nothing to say may be omitted or empty. */
export type MessagesBySource = Partial<Record<PromptSourceId, IMessage[]>>;

export function buildTaggedContextMessages(bySource: MessagesBySource): TaggedSystemMessage[] {
  return PROMPT_SOURCE_ORDER.flatMap(source => (bySource[source] ?? []).map(message => ({ source, message })));
}

/**
 * What an API caller is asking us to put in front of the model, beyond their own message.
 *
 * Exists because an external caller previously had no way to switch any of this off, which made
 * Bike4Mind impossible to compare against the bare model - and a measured comparison found the
 * stack was costing more than it added on some question shapes.
 *
 * - `raw`: only what the caller themselves supplied. Nothing we author.
 * - `grounded`: `raw` plus forced data-lake retrieval, so the answer is cited but unstyled.
 * - `surface`: `grounded` plus the prompts a product surface or org authored for the session.
 *
 * Leaving the mode unset keeps the full stack, which is what every in-app completion wants.
 */
export type PromptMode = 'raw' | 'grounded' | 'surface';

/**
 * Sources that carry the caller's own content rather than guidance we wrote. Kept in every mode:
 * silently dropping an attached file would be a worse surprise than any prompt we removed.
 */
const CALLER_SUPPLIED_SOURCES: PromptSourceId[] = ['extraContext', 'urls', 'attachedFiles'];

export const PROMPT_MODE_SOURCES: Record<PromptMode, PromptSourceId[]> = {
  raw: CALLER_SUPPLIED_SOURCES,
  grounded: [...CALLER_SUPPLIED_SOURCES, 'knowledgeRetrieval'],
  surface: [...CALLER_SUPPLIED_SOURCES, 'knowledgeRetrieval', 'organizationPrompt', 'sessionPrompt'],
};

/**
 * Which system messages survive when they do not all fit the input budget. Lower is kept first.
 *
 * Separate from PROMPT_SOURCE_ORDER on purpose: that table is the order the model SEES, which is
 * prompt-visible and drives cache-prefix reuse, whereas this one is only about what to give up. The
 * builder selects by this and re-emits survivors in assembly order.
 *
 * It exists because retention used to fall out of assembly position - the builder walked the array and
 * stopped at the first message over budget, so what it dropped was the tail. That put the org and
 * per-session prompts, the two most likely to be load-bearing for a tenant, at the back of the queue
 * behind guidance we wrote ourselves.
 *
 * Bands of 10 so a new source can be slotted in without renumbering. Anything at 50 or above is
 * reserved for the two injectors inside buildAndSortMessages (IMAGE_PROMPT_PRIORITY,
 * FORMAT_PROMPT_PRIORITY in @bike4mind/utils); they cannot be listed here because utils must not
 * import services, so a test pins the two ranges apart instead.
 */
export const SYSTEM_PROMPT_PRIORITY: Record<PromptSourceId, number> = {
  // Carry the caller's own content rather than guidance, and arrive as user-role messages that never
  // reach the system budget at all. Ranked anyway, and ranked first, so that if one ever becomes a
  // system message it inherits the rule at CALLER_SUPPLIED_SOURCES rather than a default.
  extraContext: 0,
  urls: 0,
  attachedFiles: 0,

  // Authored by the tenant or the session, or invoked by name. Losing one of these changes who the
  // assistant is, which no other source can compensate for.
  organizationPrompt: 10,
  sessionPrompt: 11,
  skills: 12,
  agentDetection: 13,
  questMaster: 14,

  // Grounding data. Absent, the model does not degrade politely - it fabricates, or denies it can see
  // something the user knows it was given.
  knowledgeRetrieval: 20,
  project: 21,
  contextSummary: 22,
  mementos: 23,
  recentImages: 24,

  // Guidance we wrote. Each one degrades gracefully: the model still answers, with worse formatting,
  // weaker abstention, or no awareness of a product surface.
  toolPrompt: 30,
  viewRegistry: 31,
  abstention: 32,
  artifactEmission: 33,
  helpCenter: 34,
  dateContext: 35,
};

/**
 * Narrow the assembled stack to what the requested mode admits, preserving assembly order.
 *
 * This is the last line of defence, not the only one: the caller also skips building the features
 * these sources come from, so a mode that reaches here with nothing to drop is the healthy case.
 */
export function filterByPromptMode(tagged: TaggedSystemMessage[], mode?: PromptMode): TaggedSystemMessage[] {
  if (!mode) return tagged;
  const admitted = new Set(PROMPT_MODE_SOURCES[mode]);
  return tagged.filter(t => admitted.has(t.source));
}

/**
 * Features excluded whenever a prompt mode is set, because filtering their messages out of the
 * prompt is not sufficient. Mementos is the reason this exists: it distils the turn into durable
 * user memory as a side effect, so suppressing only its injected text would still let an API
 * workload rewrite what the model believes about the user on every later completion. QuestMaster
 * and agent detection author their own prompt content and can replace the reply outright.
 * Context summarization writes `session.contextSummary`, an admitted source in every non-raw
 * mode, so a mode turn that ran it would quietly shape later in-app completions on the session.
 *
 * NOT excluded, deliberately: forced retrieval (registered from a session flag, and
 * `grounded`/`surface` want it), and low-stakes session grooming (auto-naming, notebook
 * summaries) whose output never re-enters a prompt. Session history itself still accrues -
 * that is what a session is.
 */
const FEATURES_EXCLUDED_BY_PROMPT_MODE = new Set<featureNames>([
  'mementos',
  'questMaster',
  'agentDetection',
  'contextSummarization',
]);

export function filterFeaturesByPromptMode<T extends string>(features: T[], mode?: PromptMode): T[] {
  if (!mode) return features;
  return features.filter(feature => !FEATURES_EXCLUDED_BY_PROMPT_MODE.has(feature as featureNames));
}

/**
 * Whether this turn runs forced data-lake retrieval. A mode overrides the session flag in both
 * directions: `raw` promises nothing but the caller's message, so a session left on forced
 * retrieval must not quietly ground it; `grounded`/`surface` promise grounding by name, so they
 * must not silently degrade to raw on a session whose flag the caller never saw (sessionRedaction
 * hides server-owned session fields, so an API caller often cannot know the flag's value).
 */
export function resolveForcedRetrieval(mode: PromptMode | undefined, sessionFlag: boolean | undefined): boolean {
  if (!mode) return Boolean(sessionFlag);
  return mode !== 'raw';
}

/**
 * How each source is reported in telemetry. `origin` answers "who authored this text" (we, an
 * admin, the org, the user's own data); `name` is the stable identifier dashboards group on, so
 * the pre-existing names are kept verbatim even where they read a little oddly.
 */
export const PROMPT_SOURCE_METADATA: Record<
  PromptSourceId,
  { origin: 'hardcoded' | 'admin' | 'user' | 'project' | 'session' | 'org'; name: string }
> = {
  dateContext: { origin: 'hardcoded', name: 'date_time_context' },
  extraContext: { origin: 'user', name: 'extra_context' },
  artifactEmission: { origin: 'admin', name: 'artifact_emission' },
  helpCenter: { origin: 'admin', name: 'help_center' },
  abstention: { origin: 'admin', name: 'abstention' },
  viewRegistry: { origin: 'hardcoded', name: 'view_registry' },
  toolPrompt: { origin: 'admin', name: 'tool_guidance' },
  agentDetection: { origin: 'hardcoded', name: 'agent_detection' },
  questMaster: { origin: 'session', name: 'quest_master' },
  organizationPrompt: { origin: 'org', name: 'organization_prompt' },
  sessionPrompt: { origin: 'session', name: 'session_prompt' },
  skills: { origin: 'session', name: 'skills' },
  knowledgeRetrieval: { origin: 'session', name: 'knowledge_retrieval' },
  contextSummary: { origin: 'session', name: 'context_summary' },
  mementos: { origin: 'user', name: 'mementos' },
  project: { origin: 'project', name: 'project_context' },
  recentImages: { origin: 'hardcoded', name: 'recent_images' },
  urls: { origin: 'user', name: 'url_content' },
  attachedFiles: { origin: 'user', name: 'attached_files' },
};

/** The canonical telemetry row shape; sourced from common so the two cannot drift. */
export type SystemPromptDetail = z.infer<typeof SystemPromptDetailSchema>;

/**
 * Roll the tagged stack up into the per-source telemetry breakdown, one row per source that
 * actually contributed. Derived from the same list the prompt is built from, so a source can no
 * longer be added to the prompt and forgotten here - which is how the previous hand-written
 * version came to omit most of the stack.
 *
 * `countTokens` is injected so this stays free of tokenizer wiring.
 *
 * `includedMessages` is the set that reached the model, by reference. Pass it whenever the payload is
 * known: the budget can now drop a system message deliberately, and without this every row would still
 * report wasIncluded true and bill its tokens, which is a false claim on the one field that exists to
 * record the opposite. Omitted, every contributing source is reported as included, which is what a
 * caller that has not built the payload yet can honestly say.
 */
export async function toPromptDetails(
  tagged: TaggedSystemMessage[],
  countTokens: (messages: IMessage[]) => Promise<number>,
  includedMessages?: ReadonlySet<IMessage>
): Promise<SystemPromptDetail[]> {
  const details: SystemPromptDetail[] = [];
  for (const source of PROMPT_SOURCE_ORDER) {
    const messages = tagged.filter(t => t.source === source).map(t => t.message);
    if (messages.length === 0) continue;
    // Tokens are counted over survivors only, so a dropped source reports zero rather than billing the
    // model for text it never saw. Partial survival still counts as included: some of the source's
    // guidance did reach the model.
    //
    // Applied to SYSTEM messages only, because identity is what the check relies on and only system
    // messages keep it: they are selected and emitted as-is, never routed through processMessages. A
    // user-role source (an attached file, URL content) IS routed through it, and truncation returns a
    // fresh object - so an identity test would report a file that arrived shortened as not delivered at
    // all, and bill it zero tokens. Content truncation has its own reporting channel; this field is
    // about the budget dropping a block whole.
    const identityIsReliable = (message: IMessage) => message.role === 'system';
    const delivered = includedMessages
      ? messages.filter(message => !identityIsReliable(message) || includedMessages.has(message))
      : messages;
    const { origin, name } = PROMPT_SOURCE_METADATA[source];
    details.push({
      source: origin,
      name,
      tokenCount: await countTokens(delivered),
      wasIncluded: delivered.length > 0,
    });
  }
  return details;
}
