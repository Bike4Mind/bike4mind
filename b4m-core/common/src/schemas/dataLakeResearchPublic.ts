import { z } from 'zod';
import { DATA_LAKE_PROPOSAL_STATUSES } from '../types/entities/DataLakeProposalTypes';
import {
  RESEARCH_COST_CEILING_MICRO_USD_LIMIT,
  RESEARCH_ITEM_RULE_ACTIONS,
  RESEARCH_MAX_AUTO_ADMITS_LIMIT,
  RESEARCH_MAX_PROPOSALS_LIMIT,
  RESEARCH_MAX_RESULTS_LIMIT,
  RESEARCH_RECENCY_DAYS_LIMIT,
  RESEARCH_REVIEW_BACKLOG_LIMIT_MAX,
  RESEARCH_RUN_STATUSES,
  RESEARCH_RUN_STOP_REASONS,
  RESEARCH_RUN_TRIGGERS,
  RESEARCH_SCHEDULE_CADENCES,
  RESEARCH_SCHEDULE_SKIP_REASONS,
  RESEARCH_SOURCES,
  RESEARCH_UNLISTED_SOURCES,
} from '../types/entities/DataLakeResearchTypes';
import { LAKE_ACCESS_PRINCIPAL_KINDS } from '../types/entities/LakeAccessEventTypes';
import {
  LAKE_CONFIG_CHANGE_ACTIONS,
  LAKE_CONFIG_EVENT_TARGET_KINDS,
  LAKE_MANAGE_RUNGS,
} from '../types/entities/LakeConfigChangeEventTypes';
import { LAKE_CONFIG_HISTORY_FILE_ACTIONS } from '../types/entities/LakeConfigHistoryTypes';
import { LAKE_MEMBERSHIP_CHANGE_ORIGINS } from '../types/entities/LakeMembershipChangeEventTypes';
import { paginatedResponseSchema } from './pagination';

/**
 * Wire schemas for the public lake research contracts
 * (api-contract/contracts/dataLakeResearch.contract.ts). snake_case, explicit and closed: a field
 * published here can be added to later but never removed, and no internal user id is on the wire.
 * Dates are ISO-8601 strings.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

// -- Levers ------------------------------------------------------------------------------------

const ItemRuleSchema = z.object({
  condition: z.string().describe('A plain-language condition the judge checks each candidate against.'),
  action: z.enum(RESEARCH_ITEM_RULE_ACTIONS).describe('`block` drops a match. `review` sends a match to the queue.'),
});

/** The settings a run executes with. Shared by a config and by the copy a run snapshots at start. */
export const ResearchLeversResourceSchema = z.object({
  source: z.enum(RESEARCH_SOURCES),
  feed_url: z.string().nullable(),
  query: z.string(),
  model: z.string().nullable().describe('The relevance judge model. Null means the platform default.'),
  max_results: z
    .number()
    .int()
    .describe(
      `How many search results or feed items one run looks at. An integer from 1 to ${RESEARCH_MAX_RESULTS_LIMIT}.`
    ),
  max_proposals: z
    .number()
    .int()
    .describe(`The most proposals one run may add to the queue. An integer from 1 to ${RESEARCH_MAX_PROPOSALS_LIMIT}.`),
  recency_days: z
    .number()
    .int()
    .nullable()
    .describe(
      `Only results from the last this many days. An integer from 0 to ${RESEARCH_RECENCY_DAYS_LIMIT}. Null or 0 means no recency constraint.`
    ),
  trusted_domains: z.array(z.string()),
  review_domains: z.array(z.string()),
  unlisted_sources: z.enum(RESEARCH_UNLISTED_SOURCES),
  auto_admit_trusted: z.boolean(),
  max_auto_admits: z
    .number()
    .int()
    .describe(
      `The most sources one run may admit without a reviewer. An integer from 1 to ${RESEARCH_MAX_AUTO_ADMITS_LIMIT}.`
    ),
  blocked_domains: z.array(z.string()),
  min_relevance: z
    .number()
    .describe(
      `The relevance a result must reach to be fetched or proposed. A fraction from 0 to 1, not a percent: 0.6 means 60%.`
    ),
  cost_ceiling_micro_usd: z
    .number()
    .int()
    .describe(
      `The most one run may spend on judging, in millionths of a US dollar. An integer from 1 to ${RESEARCH_COST_CEILING_MICRO_USD_LIMIT} (5000000 is $5.00).`
    ),
  proposed_tags: z.array(z.string()),
  item_rules: z.array(ItemRuleSchema),
});
export type ResearchLeversResource = z.infer<typeof ResearchLeversResourceSchema>;

// -- Config ------------------------------------------------------------------------------------

const LastScheduledOutcomeSchema = z.object({
  outcome: z.enum(['started', 'skipped', 'failed']),
  at: z.string(),
  run_id: z.string().nullable().describe('Set when the outcome is `started`.'),
  reason: z.enum(RESEARCH_SCHEDULE_SKIP_REASONS).nullable().describe('Set when the outcome is `skipped`.'),
  pending_proposals: z.number().int().nullable().describe('Set for a `review_backlog` skip.'),
  review_backlog_limit: z.number().int().nullable().describe('Set for a `review_backlog` skip.'),
  error: z.string().nullable().describe('A fixed sentence. Set when the outcome is `failed`.'),
});

const FeedStatusSchema = z.object({
  newest_published_at: z.string().nullable(),
  current: z.boolean().describe('The feed position was recorded under the config current settings.'),
});

export const ResearchConfigResourceSchema = ResearchLeversResourceSchema.extend({
  id: z.string(),
  lake_id: z.string(),
  name: z.string(),
  trigger: z.enum(RESEARCH_RUN_TRIGGERS),
  cadence: z.enum(RESEARCH_SCHEDULE_CADENCES),
  review_backlog_limit: z
    .number()
    .int()
    .describe(
      `Scheduled runs are held while this many proposals or more are waiting. An integer from 1 to ${RESEARCH_REVIEW_BACKLOG_LIMIT_MAX}.`
    ),
  schedule_paused: z.boolean().describe('Scheduled runs are stopped. The cadence is kept and run-now still works.'),
  held: z
    .boolean()
    .describe(
      'The schedule is waiting on review: it is active, and pending proposals are at or over `review_backlog_limit`.'
    ),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_scheduled_outcome: LastScheduledOutcomeSchema.nullable(),
  feed_status: FeedStatusSchema.nullable().describe('Feed configs only. Null for search configs.'),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type ResearchConfigResource = z.infer<typeof ResearchConfigResourceSchema>;

export const ListResearchConfigsResponseSchema = paginatedResponseSchema(ResearchConfigResourceSchema);
export const ResearchConfigResponseSchema = z.object({ data: ResearchConfigResourceSchema });

const LeverRequestFields = {
  source: z.enum(RESEARCH_SOURCES).optional(),
  feed_url: z.string().nullable().optional(),
  query: z.string().optional(),
  model: z.string().nullable().optional(),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(RESEARCH_MAX_RESULTS_LIMIT)
    .describe(
      `How many search results or feed items one run looks at. An integer from 1 to ${RESEARCH_MAX_RESULTS_LIMIT}.`
    )
    .optional(),
  max_proposals: z
    .number()
    .int()
    .min(1)
    .max(RESEARCH_MAX_PROPOSALS_LIMIT)
    .describe(`The most proposals one run may add to the queue. An integer from 1 to ${RESEARCH_MAX_PROPOSALS_LIMIT}.`)
    .optional(),
  recency_days: z
    .number()
    .int()
    .min(0)
    .max(RESEARCH_RECENCY_DAYS_LIMIT)
    .nullable()
    .describe(
      `Only results from the last this many days. An integer from 0 to ${RESEARCH_RECENCY_DAYS_LIMIT}. Null or 0 means no recency constraint.`
    )
    .optional(),
  trusted_domains: z.array(z.string()).optional(),
  review_domains: z.array(z.string()).optional(),
  unlisted_sources: z.enum(RESEARCH_UNLISTED_SOURCES).optional(),
  auto_admit_trusted: z.boolean().optional(),
  max_auto_admits: z
    .number()
    .int()
    .min(1)
    .max(RESEARCH_MAX_AUTO_ADMITS_LIMIT)
    .describe(
      `The most sources one run may admit without a reviewer. An integer from 1 to ${RESEARCH_MAX_AUTO_ADMITS_LIMIT}.`
    )
    .optional(),
  blocked_domains: z.array(z.string()).optional(),
  min_relevance: z
    .number()
    .min(0)
    .max(1)
    .describe(
      `The relevance a result must reach to be fetched or proposed. A fraction from 0 to 1, not a percent: 0.6 means 60%.`
    )
    .optional(),
  cost_ceiling_micro_usd: z
    .number()
    .int()
    .min(1)
    .max(RESEARCH_COST_CEILING_MICRO_USD_LIMIT)
    .describe(
      `The most one run may spend on judging, in millionths of a US dollar. An integer from 1 to ${RESEARCH_COST_CEILING_MICRO_USD_LIMIT} (5000000 is $5.00).`
    )
    .optional(),
  proposed_tags: z.array(z.string()).optional(),
  item_rules: z.array(ItemRuleSchema).optional(),
  cadence: z.enum(RESEARCH_SCHEDULE_CADENCES).optional(),
  review_backlog_limit: z
    .number()
    .int()
    .min(1)
    .max(RESEARCH_REVIEW_BACKLOG_LIMIT_MAX)
    .describe(
      `Scheduled runs are held while this many proposals or more are waiting. An integer from 1 to ${RESEARCH_REVIEW_BACKLOG_LIMIT_MAX}.`
    )
    .optional(),
  schedule_paused: z.boolean().optional(),
};

/** Out-of-range or non-integer numbers are rejected with 422. The SPA routes still clamp. */
export const CreateResearchConfigRequestSchema = z
  .object({
    ...LeverRequestFields,
    name: z.string().min(1),
    query: z.string().min(1).describe('What each run researches.'),
  })
  .strict();
export type CreateResearchConfigRequest = z.infer<typeof CreateResearchConfigRequestSchema>;

/** Send only the fields to change. A body of just `schedule_paused` pauses or resumes without re-validating the rest. */
export const UpdateResearchConfigRequestSchema = z
  .object({ ...LeverRequestFields, name: z.string().optional() })
  .strict();
export type UpdateResearchConfigRequest = z.infer<typeof UpdateResearchConfigRequestSchema>;

// -- Run ---------------------------------------------------------------------------------------

export const ResearchRunTotalsResourceSchema = z.object({
  search_hits: z.number().int(),
  filtered_by_source: z
    .number()
    .int()
    .describe(
      'Hits on the never list, or with no usable web address. When `unlisted_dropped` is null the run predates the split and this is the combined count.'
    ),
  unlisted_dropped: z
    .number()
    .int()
    .nullable()
    .describe('Hits from sites on none of the lists, dropped. Null for a run that predates this count.'),
  unresolved_redirect: z.number().int(),
  below_relevance: z.number().int(),
  judge_failed: z.number().int(),
  fetch_failed: z.number().int(),
  proposed: z.number().int(),
  auto_admitted: z.number().int().describe('A sub-count of `proposed`.'),
  auto_admit_skipped: z.number().int().describe('A sub-count of `proposed`.'),
  duplicate_pending: z.number().int(),
  already_in_lake: z.number().int(),
  suppressed_by_tombstone: z.number().int(),
  unusable_source: z.number().int(),
  not_judged: z.number().int(),
  blocked_by_rule: z.number().int(),
  reviewed_by_rule: z.number().int().describe('A sub-count of `proposed`.'),
});
export type ResearchRunTotalsResource = z.infer<typeof ResearchRunTotalsResourceSchema>;

export const ResearchRunResourceSchema = z.object({
  id: z.string(),
  lake_id: z.string(),
  config_id: z.string().describe('The config this run executed. It may since have been deleted.'),
  trigger: z.enum(RESEARCH_RUN_TRIGGERS),
  status: z.enum(RESEARCH_RUN_STATUSES),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string().nullable(),
  stop_reason: z.enum(RESEARCH_RUN_STOP_REASONS).nullable(),
  spent_micro_usd: z.number().int(),
  levers: ResearchLeversResourceSchema.describe('The settings the run executed with, as copied when it started.'),
  totals: ResearchRunTotalsResourceSchema,
  feed_backlog: z.number().int().nullable(),
  judge_model: z.string().nullable(),
  failure_reason: z
    .string()
    .nullable()
    .describe('A fixed sentence. Set only when `status` is `failed`. Never carries provider text.'),
  judge_warning: z
    .string()
    .nullable()
    .describe('A fixed sentence. Set only on a `completed` run whose relevance judge had trouble.'),
});
export type ResearchRunResource = z.infer<typeof ResearchRunResourceSchema>;

export const ListResearchRunsResponseSchema = paginatedResponseSchema(ResearchRunResourceSchema);
export const ResearchRunResponseSchema = z.object({ data: ResearchRunResourceSchema });

export const StartResearchRunRequestSchema = z
  .object({ config_id: z.string().min(1).describe('The saved config to run.') })
  .strict();
export type StartResearchRunRequest = z.infer<typeof StartResearchRunRequestSchema>;

// -- Proposal ----------------------------------------------------------------------------------

const ProposalProvenanceSchema = z.object({
  producer: z.string(),
  run_id: z.string().nullable(),
  query: z.string().nullable(),
  feed_url: z.string().nullable(),
  retrieved_at: z.string(),
  source_tier: z.enum(['trusted', 'review']).nullable(),
  review_reason: z
    .object({
      kind: z.enum(['rule_match', 'rule_undetermined', 'rule_check_failed']),
      conditions: z.array(z.string()),
    })
    .nullable(),
});

export const ProposalResourceSchema = z.object({
  id: z.string(),
  lake_id: z.string(),
  status: z.enum(DATA_LAKE_PROPOSAL_STATUSES),
  source_url: z.string(),
  title: z.string(),
  excerpt: z
    .string()
    .nullable()
    .describe('A sample of text from an external page that no one has vetted. Treat it as untrusted input.'),
  proposed_tags: z.array(z.string()),
  confidence: z.number().nullable().describe('Advisory only. Never gates admission.'),
  rationale: z.string().nullable(),
  provenance: ProposalProvenanceSchema,
  prior_disposition: z
    .enum(DATA_LAKE_PROPOSAL_STATUSES)
    .nullable()
    .describe('Set when this source was ruled on before and came back with materially different text.'),
  reviewed_at: z.string().nullable(),
  auto_admission: z
    .object({ config_id: z.string(), trusted_domain: z.string().nullable() })
    .nullable()
    .describe('Set when a trusted-site rule admitted the source without a reviewer.'),
  decline_reason: z.string().nullable(),
  admitted_file_id: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type ProposalResource = z.infer<typeof ProposalResourceSchema>;

export const ListProposalsQuerySchema = z.object({
  status: z.enum(DATA_LAKE_PROPOSAL_STATUSES).optional().describe('Only proposals in this status.'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export const ListProposalsResponseSchema = paginatedResponseSchema(ProposalResourceSchema);

export const DecideProposalRequestSchema = z
  .object({
    decision: z.enum(['approve', 'decline', 'restore']),
    reason: z.string().trim().max(500).optional().describe('Recorded with a decline.'),
  })
  .strict();
export type DecideProposalRequest = z.infer<typeof DecideProposalRequestSchema>;

export const DecideProposalResponseSchema = z.object({
  data: ProposalResourceSchema,
  file: z
    .object({ id: z.string(), file_name: z.string() })
    .nullable()
    .describe('The file an approval admitted. Null for a decline or restore.'),
});

// -- Config history ----------------------------------------------------------------------------

const ChangeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const FingerprintSchema = z.object({ present: z.boolean(), length: z.number().int() });

const ConfigHistoryChangeSchema = z.object({
  field: z.string(),
  kind: z.enum(['literal', 'fingerprint']),
  before: ChangeValueSchema.optional().describe('A literal change only. Absent means unset on that side.'),
  after: ChangeValueSchema.optional().describe('A literal change only. Absent means unset on that side.'),
  truncated: z.boolean().optional().describe('A literal string value was clipped.'),
  before_fingerprint: FingerprintSchema.optional().describe('A fingerprint change only. Size, never the text.'),
  after_fingerprint: FingerprintSchema.optional().describe('A fingerprint change only. Size, never the text.'),
  text_unchanged: z.boolean().optional().describe('A fingerprint change only. The two sides are the same text.'),
});

const ConfigHistoryTargetSchema = z.object({
  kind: z.enum(LAKE_CONFIG_EVENT_TARGET_KINDS),
  id: z.string(),
});

const ConfigHistoryLeverChangeSchema = z.object({
  lever: z.string(),
  before: z.unknown().describe('Absent or null means unset. A feed address is origin and path only.'),
  after: z.unknown().describe('Null on a delete, which records the setting as it stood.'),
});

const ConfigHistoryEntryBaseShape = {
  event_id: z.string(),
  changed_at: z.string(),
  principal_kind: z.enum(LAKE_ACCESS_PRINCIPAL_KINDS),
  principal_name: z.string().nullable(),
  undoable: z
    .boolean()
    .describe('True when POST .../config-history/{event_id}/undo can reverse this row: not yet undone, and supported.'),
  undone_by_event_id: z
    .string()
    .nullable()
    .describe('The row that undid this one. Null when this row was not undone, or the undoing row is outside the window.'),
};

const ConfigHistoryConfigEntrySchema = z.object({
  kind: z.literal('config'),
  ...ConfigHistoryEntryBaseShape,
  target: ConfigHistoryTargetSchema.optional().describe('The thing the row is about. Absent on older rows.'),
  manage_rung: z.enum(LAKE_MANAGE_RUNGS),
  action: z.enum(LAKE_CONFIG_CHANGE_ACTIONS),
  changes: z.array(ConfigHistoryChangeSchema),
  lever_changes: z.array(ConfigHistoryLeverChangeSchema).optional().describe('Absent on older rows.'),
  admitted_fab_file_id: z.string().optional().describe('The file an approval admitted.'),
});

const ConfigHistoryFileEntrySchema = z.object({
  kind: z.literal('file'),
  ...ConfigHistoryEntryBaseShape,
  target: ConfigHistoryTargetSchema.describe('The file the row is about.'),
  file_name: z.string().nullable().describe('The name of the file. Null when the file no longer exists.'),
  action: z.enum(LAKE_CONFIG_HISTORY_FILE_ACTIONS),
  origin: z.enum(LAKE_MEMBERSHIP_CHANGE_ORIGINS),
  undoes_event_id: z.string().optional(),
  caused_by_event_id: z.string().optional(),
});

export const ConfigHistoryEntrySchema = z.discriminatedUnion('kind', [
  ConfigHistoryConfigEntrySchema,
  ConfigHistoryFileEntrySchema,
]);

export const ConfigHistoryQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'How many of the newest config changes to return. Defaults to 200. With include=files, up to the same number of the newest file rows are returned on top; when config rows are truncated, only file rows no older than the oldest config row returned.'
    ),
  include: z
    .enum(['files'])
    .optional()
    .describe('Set to files to also return file add and remove rows. Without it only config changes are returned.'),
});

export const ConfigHistoryResponseSchema = z.object({
  data: z.object({
    lake_id: z.string(),
    lake_name: z.string(),
    entries: z.array(ConfigHistoryEntrySchema).describe('Newest first.'),
    truncated: z.boolean().describe('True when `entries` is a window rather than the whole history.'),
    window_starts_at: z.string().nullable().describe('The oldest event in the window. Set only when truncated.'),
    generated_at: z.string(),
  }),
});
export type ConfigHistoryResponse = z.infer<typeof ConfigHistoryResponseSchema>;

export const ConfigHistoryEventParamSchema = z.object({ id: z.string().min(1), event_id: z.string().min(1) });

export const UndoConfigChangeResponseSchema = z.object({
  data: ConfigHistoryEntrySchema.nullable().describe(
    'The History row the undo wrote. Null when that best-effort write did not persist; the undo still happened.'
  ),
  notes: z.array(z.string()).describe('Consequences of the undo in words, for example a schedule put on hold.'),
});
export type UndoConfigChangeResponse = z.infer<typeof UndoConfigChangeResponseSchema>;

// -- Path params -------------------------------------------------------------------------------

export const ResearchConfigParamSchema = z.object({ id: z.string().min(1), config_id: z.string().min(1) });
export const ResearchRunParamSchema = z.object({ id: z.string().min(1), run_id: z.string().min(1) });
export const ProposalParamSchema = z.object({ id: z.string().min(1), proposal_id: z.string().min(1) });
