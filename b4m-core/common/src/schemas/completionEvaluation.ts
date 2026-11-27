import { z } from 'zod';

export const CompletionEvaluationLimitsSchema = z.object({
  version: z.literal(1),
  maxProviderUsd: z.number().positive().max(150),
  maxTokens: z.number().int().positive().max(1_000_000_000),
  maxRequests: z.number().int().positive().max(10000),
  modelIds: z.array(z.string().min(1).max(128)).min(1).max(20),
});
export const CompletionEvaluationRequestSchema = z.object({ version: z.literal(1), requestId: z.uuid() });
export const CompletionEvaluationReceiptSchema = z.object({
  version: z.literal(1),
  requestId: z.uuid(),
  attemptId: z.string(),
  status: z.enum(['pending', 'complete', 'rejected-before-dispatch', 'unknown']),
  revision: z.number().int().positive(),
  modelId: z.string(),
  backend: z.string(),
  pricingRevision: z.string(),
  maxProviderUsd: z.number().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
  maxInputTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  providerUsd: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  tierBasisTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cacheWrite5mTokens: z.number().int().nonnegative().optional(),
  cacheWrite1hTokens: z.number().int().nonnegative().optional(),
  platformUsd: z.number().nonnegative().optional(),
  platformCredits: z.number().nonnegative().optional(),
  provenance: z.literal('provider-reported-usage/catalog-rates').optional(),
  rates: z.array(
    z.object({
      tier: z.number(),
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite5m: z.number().optional(),
      cacheWrite1h: z.number().optional(),
    })
  ),
});
export const CompletionEvaluationStateSchema = z.object({
  version: z.literal(1),
  limits: CompletionEvaluationLimitsSchema,
  revision: z.number().int().nonnegative(),
  committedProviderUsd: z.number().nonnegative(),
  committedTokens: z.number().int().nonnegative(),
  committedRequests: z.number().int().nonnegative(),
  receipts: z.array(CompletionEvaluationReceiptSchema),
});
export type CompletionEvaluationLimits = z.infer<typeof CompletionEvaluationLimitsSchema>;
export type CompletionEvaluationReceipt = z.infer<typeof CompletionEvaluationReceiptSchema>;
export type CompletionEvaluationState = z.infer<typeof CompletionEvaluationStateSchema>;
