import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import type { PersistedCreditHold } from './CreditHolderTypes';
import type { CompletionSource } from '../analytics';

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
  /** The request's model, so the poll can price its usage. Absent on rows from before metering. */
  model?: string;
}

/**
 * One per-request result, stored in the API response shape (snake_case
 * `client_ref`) so the poll endpoint can return cached results verbatim.
 */
export interface ITransformBatchResultItem {
  client_ref: string;
  status: 'done' | 'failed';
  reply?: string;
  tokenUsage?: {
    actualInputTokens: number;
    actualOutputTokens: number;
    /**
     * Relayed from Anthropic's usage block. A request that carried a
     * `cache_control` breakpoint reports 0 rather than omitting the field, so
     * treat absent as "not reported" and 0 as "no cache activity".
     *
     * The two write fields split `cacheCreationInputTokens`, which is their
     * sum: a 5-minute write bills 1.25x base input, a 1-hour write 2x, so the
     * sum alone cannot be priced when a request mixes them.
     */
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheWrite5mInputTokens?: number;
    cacheWrite1hInputTokens?: number;
  };
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
  /** Credits reserved at submit, settled once on the first poll that sees the batch end. */
  creditHold?: PersistedCreditHold | null;
  /**
   * Stamped in the write that clears the hold after settlement. A completed row that still has a hold
   * and no creditSettledAt was claimed but never settled (settlement is not idempotent; never redo one).
   */
  creditSettledAt?: Date;
  /** The API key that submitted the batch, for the settlement ledger row. */
  apiKeyId?: string;
  /** Ledger `source` resolved from the submit request; absent for web (JWT) submits. */
  usageSource?: CompletionSource;
}

export interface ITransformBatchRepository extends IBaseRepository<ITransformBatch> {
  findByAnthropicBatchId: (anthropicBatchId: ITransformBatch['anthropicBatchId']) => Promise<ITransformBatch | null>;
  /**
   * Atomically mark an in-progress batch completed, leaving its credit hold on the row. Returns the
   * row as it was before the update to exactly one caller (the one that settles the hold); null to the rest.
   */
  claimCompletion: (
    id: string,
    update: Pick<ITransformBatch, 'succeededCount' | 'erroredCount'>
  ) => Promise<ITransformBatch | null>;
  /** Clear the settled hold and stamp creditSettledAt in one write; a no-op once stamped. */
  markCreditSettled: (id: string) => Promise<void>;
  /** Cache the per-request results; kept out of the claim so an oversized payload cannot block it. */
  saveResults: (id: string, results: NonNullable<ITransformBatch['results']>) => Promise<void>;
}
