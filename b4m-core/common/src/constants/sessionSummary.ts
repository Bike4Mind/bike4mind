/**
 * Why a session summarization happened, stamped on `ISession.summaryTrigger`. Single source for the
 * places that each used to spell this list out: the Session zod schema (schemas/actions.ts), the
 * entity type (types/entities/SessionTypes.ts), the Mongoose path (packages/database SessionModel)
 * and the session.summarize event payload (apps/client server/utils/eventBus.ts). They drifted -
 * the Mongoose enum said 'milestone'/'growth' for two values nothing produces - and a drift there
 * is invisible on the update path, because BaseModel's findOneAndUpdate writes without
 * runValidators.
 *
 * Those surfaces now name PERSISTED_SESSION_SUMMARY_TRIGGERS below, not the full union: a stored
 * field may only carry a reason a run HAPPENED. 'throttling' is the exception that forced the
 * split - shouldSummarizeSession (b4m-core/services ChatCompletionFeatures) returns it as the
 * reason it DECLINED to summarize, so it describes no run and belongs to a decision, not a
 * document. It is typed by SummarizationDecision there, not by the session field.
 *
 * 'manual' means someone asked for one notebook's summary. The admin sweep (apps/client
 * server/events/spider.ts) summarizes every un-summarized notebook of the admin who ran it in one
 * billed pass, so it stamps 'spider' instead: without that, one deliberate click and a whole sweep
 * are indistinguishable when someone investigates unexpected summarization spend.
 */
/**
 * The triggers a document may actually carry - every reason a summarization HAPPENED. The event
 * payload and createSessionParametersSchema both name this list rather than the full union below,
 * so 'throttling' cannot be published, cannot be stored, and therefore cannot reach a copy path.
 * Add a new reason-it-happened here, not to SESSION_SUMMARY_TRIGGERS, and every one of those
 * boundaries picks it up.
 */
export const PERSISTED_SESSION_SUMMARY_TRIGGERS = [
  'manual',
  'project',
  'earlyMilestone',
  'contentGrowth',
  'spider',
] as const;

/**
 * Everything a summarization CHECK can conclude: the persisted reasons plus 'throttling', which
 * only ever describes a decision not to summarize. Keep this the type of a decision result, not of
 * a stored field - ISessionDocument still uses it for compatibility, but no write accepts it.
 */
export const SESSION_SUMMARY_TRIGGERS = [...PERSISTED_SESSION_SUMMARY_TRIGGERS, 'throttling'] as const;

export type SessionSummaryTrigger = (typeof SESSION_SUMMARY_TRIGGERS)[number];
export type PersistedSessionSummaryTrigger = (typeof PERSISTED_SESSION_SUMMARY_TRIGGERS)[number];

/**
 * Narrows a stored value to what a write may carry, so a copy of a document that somehow holds a
 * decision-only trigger loses the provenance instead of failing the copy. Nothing can store
 * 'throttling' today - the field was never written before the enum was aligned, and both write
 * boundaries now refuse it - but a copy path must not be the thing that discovers otherwise.
 */
export const toPersistedSummaryTrigger = (
  trigger: SessionSummaryTrigger | undefined
): PersistedSessionSummaryTrigger | undefined =>
  trigger !== undefined && (PERSISTED_SESSION_SUMMARY_TRIGGERS as readonly string[]).includes(trigger)
    ? (trigger as PersistedSessionSummaryTrigger)
    : undefined;
