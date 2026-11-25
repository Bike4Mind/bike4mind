import { z } from 'zod';
import { PROMPT_CACHE_TTLS } from '@bike4mind/common';
import { REASONING_EFFORT_SETTINGS } from '@bike4mind/local-models/model-settings';

export const newSessionDefaultsSchema = z.object({
  model: z.string().min(1),
  approvalMode: z.enum(['ask', 'auto', 'full']),
  reasoningEffort: z.enum(REASONING_EFFORT_SETTINGS),
  promptCacheTtl: z.enum(PROMPT_CACHE_TTLS).optional(),
});

export type NewSessionDefaults = z.infer<typeof newSessionDefaultsSchema>;
