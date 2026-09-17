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
