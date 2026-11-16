import { z } from 'zod';
import type { LLMModelConfig, ModelAccessEntry } from '@bike4mind/common';

const ConfigurationSchema = z.object({
  id: z.string().min(1),
  enabled: z
    .boolean()
    .optional()
    .transform(value => value === true),
  allowedUserTags: z.array(z.string()).default([]),
  allowedEntitlements: z.array(z.string()).optional(),
  fallbackModel: z.string().optional(),
  rank: z.number().optional(),
  updatedAt: z.iso.datetime().nullable().optional(),
});
/** GET /api/admin/llm-models/configurations. `updatedAt` is present for full admins only. */
export const ModelConfigurationsResponseSchema = z.object({ settingValue: z.array(ConfigurationSchema) });
export type SavedModelConfiguration = z.infer<typeof ConfigurationSchema>;
export type ModelConfigurationsRead = { configurations: SavedModelConfiguration[]; revision: string | null };
export type LoadedModelConfiguration = LLMModelConfig & { accessEntry: ModelAccessEntry | null };

export const loadedAccessEntry = (entry: SavedModelConfiguration): ModelAccessEntry => ({
  ...entry,
  allowedEntitlements: entry.allowedEntitlements ?? [],
  updatedAt: entry.updatedAt ?? null,
});
