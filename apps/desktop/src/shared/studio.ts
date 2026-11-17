import { z } from 'zod';

export const studioIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const studioMediaKindSchema = z.enum(['image', 'video', 'music', 'speech', 'sound-effect']);
export type StudioMediaKind = z.infer<typeof studioMediaKindSchema>;

export const studioWorkspaceIdentitySchema = z.object({
  workspaceId: studioIdSchema,
  rootSessionId: studioIdSchema,
});
export type StudioWorkspaceIdentity = z.infer<typeof studioWorkspaceIdentitySchema>;

export interface StudioContextSelection {
  mode: 'current-session' | 'session-family' | 'custom';
  sessionIds?: string[];
  files?: string[];
}

export const studioProvenanceSchema = z.object({
  preparedAt: z.string(),
  sessions: z.array(z.object({ sessionId: studioIdSchema, messageIds: z.array(z.string()) })),
  files: z.array(z.object({ path: z.string(), sha256: z.string().optional() })),
  warnings: z.array(z.string()),
});
export type StudioProvenance = z.infer<typeof studioProvenanceSchema>;

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
  assetIds: z.array(studioIdSchema),
  error: z.string().optional(),
  provenance: studioProvenanceSchema.optional(),
});
export type StudioJob = z.infer<typeof studioJobSchema>;

export interface StudioWorkspace extends StudioWorkspaceIdentity {
  assets: StudioAsset[];
  jobs: StudioJob[];
  nextAssetCursor?: string;
  nextJobCursor?: string;
}
