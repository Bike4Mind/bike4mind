import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { ApiErrorSchema } from './chat';

export const MAX_REFINE_TEXT_CHARS = 10_000;
export const MAX_REFINE_CONTEXT_CHARS = 10_000;

export const TextRefinementRequestSchema = z.object({
  text: z.string().min(1).max(MAX_REFINE_TEXT_CHARS),
  context: z.string().max(MAX_REFINE_CONTEXT_CHARS).optional(),
});

export type TextRefinementRequest = z.infer<typeof TextRefinementRequestSchema>;

export const TextRefinementResponseSchema = z.object({
  text: z.string(),
});

export type TextRefinementResponse = z.infer<typeof TextRefinementResponseSchema>;

export const TEXT_REFINEMENT_ERROR_CODES = [
  'provider_not_configured',
  'provider_rejected',
] as const satisfies readonly ApiErrorCode[];

export const TextRefinementErrorSchema = ApiErrorSchema.extend({
  errorCode: z.enum(TEXT_REFINEMENT_ERROR_CODES).optional(),
});
