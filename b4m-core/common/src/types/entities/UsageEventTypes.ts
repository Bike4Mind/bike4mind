import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { CreditHolderType } from './CreditHolderTypes';

/**
 * Which product surface generated the provider call.
 */
export const USAGE_EVENT_FEATURES = [
  'chat',
  'image_generation',
  'image_edit',
  'video_generation',
  'voice',
  'transcription',
  'agent_execution',
  'completion_api',
  'tool',
] as const;

export type UsageEventFeature = (typeof USAGE_EVENT_FEATURES)[number];

export const USAGE_EVENT_STATUSES = ['ok', 'error', 'timeout'] as const;

export type UsageEventStatus = (typeof USAGE_EVENT_STATUSES)[number];

/**
 * One row per provider API call. Ties true COGS (costUsd, frozen
 * at write time) to what the user was debited (creditsCharged) so margin per
 * model/user is queryable. Dual-written at settlement time; never part of the
 * billing path itself.
 */
export const UsageEvent = z.object({
  id: z.string().optional(), // MongoDB ObjectId
  /** App-level correlation id: questId for chat/image/video, session/run id otherwise. */
  requestId: z.string(),
  userId: z.string(),
  /** Credit holder actually debited (user or organization). */
  ownerId: z.string(),
  ownerType: z.enum(CreditHolderType),
  sessionId: z.string().optional(),
  feature: z.enum(USAGE_EVENT_FEATURES),
  /** Provider/backend, e.g. 'bedrock', 'openai', 'gemini'. */
  provider: z.string(),
  /** Exact model id string used for the call. */
  model: z.string(),

  // Token quantities. inputTokens/outputTokens are the BILLING basis (currently
  // the local tokenizer). providerInputTokens/providerOutputTokens are what the
  // provider reported; the delta quantifies the known local over-count.
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cachedInputTokens: z.number().default(0),
  cacheWriteTokens: z.number().default(0),
  providerInputTokens: z.number().optional(),
  providerOutputTokens: z.number().optional(),
  /** Images generated / video seconds, for per-unit modalities. */
  units: z.number().optional(),

  /** True provider COGS in USD, computed and frozen at write time. */
  costUsd: z.number(),
  /** Credits actually debited from the owner for this call. */
  creditsCharged: z.number(),

  status: z.enum(USAGE_EVENT_STATUSES).default('ok'),
  latencyMs: z.number().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type IUsageEvent = z.infer<typeof UsageEvent>;

export type IUsageEventDocument = IUsageEvent & IMongoDocument;

/** Input for recording an event (server sets id/timestamps). */
export type IUsageEventInput = Omit<IUsageEvent, 'id' | 'createdAt' | 'updatedAt'>;

/** One aggregation bucket of v_margin_by_model_day (schema-doc naming). */
export interface IModelDayMargin {
  day: string; // YYYY-MM-DD (UTC)
  provider: string;
  model: string;
  requests: number;
  cogsUsd: number;
  creditsCharged: number;
}

/** One aggregation bucket of margin-by-user. */
export interface IUserMargin {
  userId: string;
  requests: number;
  cogsUsd: number;
  creditsCharged: number;
}

/** One aggregation bucket of monthly COGS by provider (invoice reconciliation). */
export interface IProviderMonthCogs {
  month: string; // YYYY-MM (UTC)
  provider: string;
  requests: number;
  cogsUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface IUsageEventRepository extends IBaseRepository<IUsageEventDocument> {
  /** Append one event. Must never throw into the billing path; callers fire-and-forget. */
  record(event: IUsageEventInput): Promise<IUsageEventDocument | null>;

  /** Margin buckets per model per day since the given date (default 30 days back). */
  marginByModelDay(since?: Date): Promise<IModelDayMargin[]>;

  /** Margin buckets per user over the trailing N days (default 30), worst margin first. */
  marginByUser(days?: number): Promise<IUserMargin[]>;

  /** Monthly COGS per provider for invoice reconciliation, newest month first. */
  monthlyCogsByProvider(): Promise<IProviderMonthCogs[]>;
}
