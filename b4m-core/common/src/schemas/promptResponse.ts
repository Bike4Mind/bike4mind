import * as z from 'zod';
import type { IPromptDocument } from '../types/entities/PromptTypes';
import { passthroughField, passthroughShape } from './responseShape';

// Held to IPromptDocument: a new IPrompt field fails the build here until it is listed.
const PROMPT_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  type: true,
  name: true,
  promptText: true,
  tags: true,
} as const satisfies Record<keyof IPromptDocument, true>;

/**
 * A prompt as returned by the /api/prompts routes. PromptSchema stores its update time as
 * `lastUpdated` (timestamps.updatedAt rename), which IPromptDocument does not declare.
 */
export const promptResponseSchema = z.object({
  ...passthroughShape(PROMPT_RESPONSE_FIELDS),
  lastUpdated: passthroughField,
});

export const promptListResponseSchema = z.array(promptResponseSchema);
