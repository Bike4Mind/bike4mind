/**
 * Why a session summarization happened, stamped on `ISession.summaryTrigger`. Single source for
 * the four places that each used to spell this list out: the Session zod schema
 * (schemas/actions.ts), the entity type (types/entities/SessionTypes.ts), the Mongoose path
 * (packages/database SessionModel) and the session.summarize event payload (apps/client
 * server/utils/eventBus.ts). They drifted - the Mongoose enum said 'milestone'/'growth' for two
 * values nothing produces - and a drift there is invisible at runtime, because BaseModel's
 * findOneAndUpdate writes without runValidators.
 *
 * 'throttling' is the one member no stored document can carry: shouldSummarizeSession
 * (b4m-core/services ChatCompletionFeatures) returns it as the reason it declined to summarize,
 * so it never reaches a write. It stays in the union because that return value is typed as
 * `ISessionDocument['summaryTrigger']`.
 *
 * 'manual' means someone asked for one notebook's summary. The admin sweep (apps/client
 * server/events/spider.ts) summarizes every un-summarized notebook of the admin who ran it in one
 * billed pass, so it stamps 'spider' instead: without that, one deliberate click and a whole sweep
 * are indistinguishable when someone investigates unexpected summarization spend.
 */
export const SESSION_SUMMARY_TRIGGERS = [
  'manual',
  'project',
  'earlyMilestone',
  'contentGrowth',
  'throttling',
  'spider',
] as const;

export type SessionSummaryTrigger = (typeof SESSION_SUMMARY_TRIGGERS)[number];
