import { z } from 'zod';
import { COMPLETION_SOURCES } from '../types/analytics';
import { USAGE_EVENT_FEATURES, USAGE_EVENT_OPERATIONS, USAGE_EVENT_STATUSES } from '../types/entities/UsageEventTypes';

/**
 * GET /api/admin/users/[userId]/usage-receipt: what one charged request cost and why, for an admin
 * investigating spend. PRIVACY CONTRACT: metadata only. No prompt or reply text, file names, notebook
 * titles or tool arguments may ever be added here; the response boundary strips anything not listed,
 * and adminUsageReceipt.test.ts fails if a content-shaped key appears in this schema.
 */
export const adminUsageReceiptQuerySchema = z.object({
  requestId: z.string().min(1).max(128),
  /** When the charge happened (the ledger row's time); bounds the lookup to the day around it. */
  at: z.iso.datetime(),
});
export type AdminUsageReceiptQuery = z.infer<typeof adminUsageReceiptQuerySchema>;

const creditsSchema = z.object({
  /** What the request cost. */
  cost: z.number(),
  /** What the balance paid: cost minus writtenOff. */
  charged: z.number(),
  /** Cost the balance could not cover on a capped turn, never collected. */
  writtenOff: z.number(),
});

/** One provider call (one UsageEvent) of the request. */
export const adminUsageReceiptCallSchema = z.object({
  id: z.string(),
  at: z.string(),
  feature: z.enum(USAGE_EVENT_FEATURES),
  /** The background job, on a system-sourced operational call. */
  operation: z.enum(USAGE_EVENT_OPERATIONS).optional(),
  model: z.string(),
  /** Set only when a different model actually ran (a restricted-tier substitution). */
  executedModel: z.string().optional(),
  source: z.enum(COMPLETION_SOURCES).optional(),
  apiKeyPrefix: z.string().optional(),
  status: z.enum(USAGE_EVENT_STATUSES),
  stopReason: z.string().optional(),
  latencyMs: z.number().optional(),
  tokens: z.object({
    /** Uncached input. Provider count when the provider reported one, else the local estimate. */
    input: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    /** All output the provider billed, thinking included. */
    output: z.number(),
    /** The visible reply, by the local tokenizer. */
    visibleOutput: z.number(),
    /** output minus visibleOutput: an estimate, present only when the provider reported output. */
    thinking: z.number().optional(),
    /** Which count priced the call. */
    basis: z.enum(['provider', 'local']).optional(),
  }),
  credits: creditsSchema.extend({
    /** The credit hold placed before the call ran. */
    reserved: z.number().optional(),
  }),
  costUsd: z.number(),
  limits: z.object({
    /** The output ceiling the call was sent with. */
    maxOutputTokens: z.number().optional(),
    /** True when the balance cap lowered the output budget; creditCapOutputTokens is the lowest it set. */
    capBound: z.boolean(),
    creditCapOutputTokens: z.number().optional(),
    stoppedForCredits: z.boolean(),
    reasoningEffort: z.string().optional(),
    thinkingBudgetTokens: z.number().optional(),
  }),
  /** Tool calls by tool name; names only, never arguments or results. */
  toolCalls: z.array(z.object({ name: z.string(), count: z.number() })),
  /** Count and total size only, never names. */
  attachments: z.object({ count: z.number(), totalBytes: z.number() }),
  /** False on calls recorded before the receipt fields existed: limits, tools and attachments read as unknown. */
  detailRecorded: z.boolean(),
});
export type AdminUsageReceiptCall = z.infer<typeof adminUsageReceiptCallSchema>;

/** A ledger row the request wrote. */
export const adminUsageReceiptLedgerRowSchema = z.object({
  id: z.string(),
  at: z.string(),
  type: z.string(),
  /** Signed credits charged to the balance. */
  credits: z.number(),
  writtenOffCredits: z.number().optional(),
});

export const adminUsageReceiptSchema = z.object({
  requestId: z.string(),
  calls: z.array(adminUsageReceiptCallSchema),
  ledger: z.array(adminUsageReceiptLedgerRowSchema),
  /** Summed over calls. Tool charges billed on their own ledger row are not part of a call's cost. */
  totals: creditsSchema,
});
export type AdminUsageReceipt = z.infer<typeof adminUsageReceiptSchema>;
