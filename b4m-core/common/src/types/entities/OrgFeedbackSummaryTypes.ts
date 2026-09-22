import { z } from 'zod';
import type { FeedbackCountBucket } from './FeedbackTypes';

/** Discriminator the org feedback summary carries on the shared quest-export queue. */
export const ORG_FEEDBACK_SUMMARY_JOB_TYPE = 'orgFeedbackSummary';

/** The states the worker reports over the websocket; 'pending' never travels, it is the DB's. */
export type OrgFeedbackSummaryProgressStatus = 'processing' | 'completed' | 'failed';

/**
 * The counts the summary prose was written from, kept beside it so a reader can check the model
 * against the same numbers the Analysis tab shows.
 *
 * These are the ONLY feedback fields that reach the LLM. No content, no usernames, no ids: the
 * verbatim text lives behind a CASL check that grants it to the reporter or a platform admin, and
 * an org owner is neither. Whatever is added here is added to the prompt.
 */
export interface OrgFeedbackSummaryCounts {
  totals: { count: number };
  byDay: { day: string; count: number }[];
  bySubject: FeedbackCountBucket[];
  byType: FeedbackCountBucket[];
  byStatus: FeedbackCountBucket[];
  byTag: FeedbackCountBucket[];
  /** Optional, and load-bearing so: completed artifacts already in S3 carry no such key, and they
   * are re-parsed with the schema below on every read. */
  byTagTruncated?: boolean;
}

/** The JSON artifact the worker writes to S3 and the read route hands back. */
export interface OrgFeedbackSummaryArtifact {
  summaryJobId: string;
  organizationId: string;
  range: { from: string; to: string };
  generatedAt: string;
  model: string;
  summary: string;
  counts: OrgFeedbackSummaryCounts;
}

const feedbackCountBucketSchema = z.object({ key: z.string(), count: z.number() });

const orgFeedbackSummaryCountsSchema = z.object({
  totals: z.object({ count: z.number() }),
  byDay: z.array(z.object({ day: z.string(), count: z.number() })),
  bySubject: z.array(feedbackCountBucketSchema),
  byType: z.array(feedbackCountBucketSchema),
  byStatus: z.array(feedbackCountBucketSchema),
  byTag: z.array(feedbackCountBucketSchema),
  byTagTruncated: z.boolean().optional(),
}) satisfies z.ZodType<OrgFeedbackSummaryCounts>;

/**
 * Validates the S3-persisted artifact at the read boundary. `satisfies` keeps this shape pinned to
 * `OrgFeedbackSummaryArtifact` at compile time, so the two cannot drift silently.
 */
export const orgFeedbackSummaryArtifactSchema = z.object({
  summaryJobId: z.string(),
  organizationId: z.string(),
  range: z.object({ from: z.string(), to: z.string() }),
  generatedAt: z.string(),
  model: z.string(),
  summary: z.string(),
  counts: orgFeedbackSummaryCountsSchema,
}) satisfies z.ZodType<OrgFeedbackSummaryArtifact>;

/**
 * GET /api/organizations/:id/feedback-summary for one window.
 *
 * 'none' is a real answer, not an error: nobody has asked for this window yet. The artifact is
 * inlined rather than handed over as a signed URL because the panel renders the prose itself, and
 * a URL would expire between the job finishing and the tab being opened.
 */
export interface OrgFeedbackSummaryView {
  status: 'none' | 'pending' | 'processing' | 'completed' | 'failed';
  summaryJobId?: string;
  errorMessage?: string;
  artifact?: OrgFeedbackSummaryArtifact;
}
