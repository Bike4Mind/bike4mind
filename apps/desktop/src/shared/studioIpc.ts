import { z } from 'zod';
import { studioIdSchema, studioMediaKindSchema, type StudioWorkspace } from './studio';

export const studioDraftSchema = z
  .object({
    sessionId: studioIdSchema,
    workspaceId: studioIdSchema,
    revision: z.string().max(128),
    kind: studioMediaKindSchema,
    prompt: z.string().trim().min(1).max(16_384),
    selection: z
      .object({
        mode: z.enum(['current-session', 'session-family', 'custom']),
        sessionIds: z.array(studioIdSchema).max(256).optional(),
        files: z.array(z.string().min(1).max(4096)).max(32).optional(),
      })
      .strict(),
    settings: z
      .object({
        size: z.string().max(64).optional(),
        durationSeconds: z.number().positive().max(600).optional(),
        aspectRatio: z.string().max(32).optional(),
        resolution: z.string().max(32).optional(),
        instrumental: z.boolean().optional(),
        voice: z.string().max(128).optional(),
        format: z.string().max(32).optional(),
        promptInfluence: z.number().min(0).max(1).optional(),
      })
      .strict(),
  })
  .strict();
export type StudioDraft = z.infer<typeof studioDraftSchema>;
export const studioCreateSchema = z
  .object({
    draft: studioDraftSchema,
    reviewId: studioIdSchema,
    preparedPrompt: z.string().trim().min(1).max(32_768),
  })
  .strict();
export type StudioCreate = z.infer<typeof studioCreateSchema>;
export interface StudioReview {
  id: string;
  preparedPrompt: string;
  sources: readonly { sessionId: string; title: string }[];
  exclusions: readonly string[];
  truncation: readonly string[];
  warnings: readonly string[];
}
export interface StudioLiveState {
  sessionId: string;
  revision: string;
  workspace: StudioWorkspace;
  sessions: { id: string; title: string }[];
  available: boolean;
}
export const studioAssetActionSchema = z
  .object({
    sessionId: studioIdSchema,
    assetId: studioIdSchema,
    action: z.enum(['preview', 'rename', 'delete', 'export', 'reuse']),
    title: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type StudioAssetAction = z.infer<typeof studioAssetActionSchema>;
export interface StudioApi {
  get(sessionId: string): Promise<StudioLiveState>;
  prepare(draft: StudioDraft): Promise<StudioReview>;
  create(request: StudioCreate): Promise<void>;
  pickFiles(sessionId: string): Promise<string[]>;
  assetAction(request: StudioAssetAction): Promise<void>;
  onChanged(listener: (event: { sessionId: string; workspaceId: string }) => void): () => void;
}
