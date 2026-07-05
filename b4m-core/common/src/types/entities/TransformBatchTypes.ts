import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Lifecycle of a submitted Anthropic Message Batch, tracked locally so the
 * poll endpoint can short-circuit once results are in. `in_progress` until
 * Anthropic's `processing_status === "ended"`, then `completed` (results
 * fetched + cached on the row).
 */
export type TransformBatchStatus = 'in_progress' | 'completed';

/** Maps the spec-safe Anthropic `custom_id` we generate to the consumer's `clientRef`. */
export interface ITransformBatchCustomIdMapping {
  customId: string;
  clientRef: string;
}

/**
 * One per-request result, stored in the API response shape (snake_case
 * `client_ref`) so the poll endpoint can return cached results verbatim.
 */
export interface ITransformBatchResultItem {
  client_ref: string;
  status: 'done' | 'failed';
  reply?: string;
  tokenUsage?: { actualInputTokens: number; actualOutputTokens: number };
  error?: string;
}

export interface ITransformBatch extends IMongoDocument {
  /** User id resolved from the caller's API key - owns this batch. */
  ownerUserId: string;
  /** Anthropic's batch id (`msgbatch_...`). */
  anthropicBatchId: string;
  status: TransformBatchStatus;
  requestCount: number;
  succeededCount: number;
  erroredCount: number;
  customIdMap: ITransformBatchCustomIdMapping[];
  /**
   * Per-request results, cached once the batch ends so subsequent polls don't
   * re-stream the JSONL from Anthropic. Note: holds full replies - fine at our
   * batch sizes (hundreds), but a 10k-request batch could approach Mongo's
   * 16MB doc cap; revisit (e.g. offload to S3) if batch sizes grow.
   */
  results?: ITransformBatchResultItem[];
}

export interface ITransformBatchRepository extends IBaseRepository<ITransformBatch> {
  findByAnthropicBatchId: (anthropicBatchId: ITransformBatch['anthropicBatchId']) => Promise<ITransformBatch | null>;
}
