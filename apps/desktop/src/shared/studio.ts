import { z } from 'zod';

export const studioIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const studioMediaKindSchema = z.enum(['image', 'video', 'music', 'speech', 'sound-effect']);
export type StudioMediaKind = z.infer<typeof studioMediaKindSchema>;

export const studioWorkspaceIdentitySchema = z.object({
  workspaceId: studioIdSchema,
  rootSessionId: studioIdSchema,
});
export type StudioWorkspaceIdentity = z.infer<typeof studioWorkspaceIdentitySchema>;

export const studioContextSelectionSchema = z
  .object({
    mode: z.enum(['current-session', 'session-family', 'custom', 'none']),
    sessionIds: z.array(studioIdSchema).max(256).optional(),
    files: z.array(z.string().min(1).max(4096)).max(32).optional(),
  })
  .strict();
export type StudioContextSelection = z.infer<typeof studioContextSelectionSchema>;

export const studioProvenanceSchema = z.object({
  preparedAt: z.string(),
  sessions: z.array(z.object({ sessionId: studioIdSchema, messageIds: z.array(z.string()) })),
  files: z.array(z.object({ path: z.string(), sha256: z.string().optional() })),
  warnings: z.array(z.string()),
});
export type StudioProvenance = z.infer<typeof studioProvenanceSchema>;

export const studioSettingsSchema = z
  .object({
    model: z.string().min(1).max(256).optional(),
    provider: z.enum(['openai', 'elevenlabs']).optional(),
    count: z.number().int().min(1).max(4).optional(),
    quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'standard', 'hd']).optional(),
    references: z
      .array(z.object({ fileId: z.string().regex(/^[0-9a-f]{24}$/), name: z.string().max(256) }).strict())
      .max(16)
      .optional(),
    mode: z.enum(['text_to_video', 'image_to_video']).optional(),
    audio: z.boolean().optional(),
    lyrics: z.string().max(10_000).optional(),
    stability: z.number().min(0).max(1).optional(),
    similarityBoost: z.number().min(0).max(1).optional(),
    languageCode: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
    size: z.string().max(64).optional(),
    durationSeconds: z.number().positive().max(600).optional(),
    aspectRatio: z.string().max(32).optional(),
    resolution: z.string().max(32).optional(),
    instrumental: z.boolean().optional(),
    voice: z.string().max(128).optional(),
    format: z.string().max(32).optional(),
    promptInfluence: z.number().min(0).max(1).optional(),
  })
  .strict();
export const studioCreationSchema = z
  .object({
    prompt: z.string().min(1).max(32_768),
    settings: studioSettingsSchema,
    selection: studioContextSelectionSchema.optional(),
  })
  .strict();

export const studioAssetSchema = z.object({
  id: studioIdSchema,
  kind: studioMediaKindSchema,
  title: z.string(),
  originatingSessionId: studioIdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
  mimeType: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  jobId: studioIdSchema.optional(),
  provenance: studioProvenanceSchema.optional(),
  creation: studioCreationSchema.optional(),
});
export type StudioAsset = z.infer<typeof studioAssetSchema>;

export const studioJobSchema = z.object({
  id: studioIdSchema,
  kind: studioMediaKindSchema,
  originatingSessionId: studioIdSchema,
  state: z.enum(['submitting', 'queued', 'running', 'completed', 'failed', 'cancelled', 'unknown']),
  createdAt: z.string(),
  updatedAt: z.string(),
  idempotencyKey: z.string(),
  providerJobId: z.string().optional(),
  providerJobIds: z.array(z.string()).max(4).optional(),
  providerGroupId: z.string().optional(),
  imageBatch: z.boolean().optional(),
  outputErrors: z.array(z.string()).optional(),
  assetIds: z.array(studioIdSchema),
  error: z.string().optional(),
  errorCode: z.string().max(100).optional(),
  recoveryExpired: z.boolean().optional(),
  provenance: studioProvenanceSchema.optional(),
  creation: studioCreationSchema.optional(),
});
export type StudioJob = z.infer<typeof studioJobSchema>;

export interface StudioWorkspace extends StudioWorkspaceIdentity {
  assets: StudioAsset[];
  jobs: StudioJob[];
  nextAssetCursor?: string;
  nextJobCursor?: string;
}
