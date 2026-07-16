import { z } from 'zod';
import { CurationType, CurationTypeSchema, CurationArtifactTypeSchema, ExportFormatSchema } from '@bike4mind/common';

export const ApiErrorSchema = z.object({
  status: z.number(),
  message: z.string(),
  code: z.string().optional(),
});

export const CreateApiKeyRequestSchema = z.object({
  type: z.string(),
  description: z.string(),
  apiKey: z.string(),
  isActive: z.boolean(),
  expireDays: z.number().positive(),
});

export const UpdateUserRequestSchema = z.object({
  password: z.string().nullable().optional(),
  username: z.string().optional(),
  name: z.string().optional(),
  email: z.email().optional(),
  profilePicture: z.url().optional(),
  id: z.string().optional(),
});

export const CreateSessionRequestSchema = z.object({
  name: z.string().min(1),
  tags: z
    .array(
      z.object({
        name: z.string(),
        strength: z.number().min(0).max(1),
      })
    )
    .optional(),
  knowledgeIds: z.array(z.string()).optional(),
  artifactIds: z.array(z.string()).optional(),
  projectId: z.string().optional(),
  systemPromptText: z.string().optional(),
  surface: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
  forceKnowledgeRetrieval: z.boolean().optional(),
  retrievalTags: z.array(z.string()).optional(),
  retrievalExcludeFilenameMarkers: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  retrievalVectorizedOnly: z.boolean().optional(),
  temperature: z.number().optional(),
});

export const ProjectFilesRequestSchema = z.object({
  fileIds: z.array(z.string().min(1)),
});

export const ProjectSessionsRequestSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(50),
});

export const FileTagToggleRequestSchema = z.object({
  ids: z.array(z.string().min(1)),
  tags: z.array(z.string().min(1)),
});

export const FileTagCreateRequestSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  name: z.string().optional(),
  icon: z.string().optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
});

export const ProjectCreateRequestSchema = z.object({
  description: z.string().min(1),
  name: z.string().min(1),
  sessionIds: z.array(z.string()).optional(),
  fileIds: z.array(z.string()).optional(),
});

export const ProjectInviteRequestSchema = z.object({
  permissions: z.array(z.string().min(1)),
  description: z.string().optional(),
  expiresAt: z.date().optional(),
  recipients: z.array(z.email()).optional(),
  available: z.number().positive().optional(),
});

export const NotebookExportRequestSchema = z.object({
  includeKnowledge: z.boolean().optional().prefault(true),
  includeArtifacts: z.boolean().optional().prefault(true),
  includeTools: z.boolean().optional().prefault(true),
  includeAgents: z.boolean().optional().prefault(true),
  anonymize: z.boolean().optional().prefault(false),
  includeMetadata: z.boolean().optional().prefault(true),
  includeImages: z.boolean().optional().prefault(true),
  maxFileSize: z
    .number()
    .positive()
    .optional()
    .prefault(10 * 1024 * 1024), // 10MB default
  notebookIds: z.array(z.string()).optional(),
  fromDate: z.iso.datetime().optional(),
  toDate: z.iso.datetime().optional(),
});

export const NotebookCurateRequestSchema = z.object({
  sessionIds: z
    .array(z.string().min(1))
    .min(1, 'At least one session ID is required')
    .max(50, 'Maximum 50 sessions per curation request'),
  curationType: CurationTypeSchema.optional().prefault(CurationType.TRANSCRIPT),
  artifactTypes: z.array(CurationArtifactTypeSchema).optional(),
  exportFormat: ExportFormatSchema.optional().prefault('markdown'),
  customNotebookName: z.string().optional(),
});

export const NotebookDownloadRequestSchema = z.object({
  sessionIds: z
    .array(z.string().min(1))
    .min(1, 'At least one session ID is required')
    .max(50, 'Maximum 50 sessions per download'),
  format: ExportFormatSchema.optional().prefault('markdown'),
  downloadAsZip: z.boolean().optional().prefault(false), // If true, zip all files together
});

const BaseEmailRequestSchema = z.object({
  recipients: z.array(z.email()).min(1, 'At least one recipient email is required'),
  message: z.string().optional(),
});

export const EmailSendRequestSchema = z.discriminatedUnion('type', [
  BaseEmailRequestSchema.extend({
    type: z.literal('notebooks'),
    sessionIds: z
      .array(z.string().min(1))
      .min(1, 'At least one session ID is required')
      .max(50, 'Maximum 50 sessions per email'),
    format: ExportFormatSchema.optional().prefault('markdown'),
  }),
  BaseEmailRequestSchema.extend({
    type: z.literal('files'),
    fileIds: z.array(z.string().min(1)).min(1, 'At least one file ID is required'),
  }),
]);

// Legacy schemas for backward compatibility (deprecated - use EmailSendRequestSchema)
export const NotebookEmailRequestSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1, 'At least one session ID is required'),
  recipients: z.array(z.email()).min(1, 'At least one recipient email is required'),
  format: ExportFormatSchema.optional().prefault('markdown'),
  message: z.string().optional(),
});

export const FabFileEmailRequestSchema = z.object({
  fileIds: z.array(z.string().min(1)).min(1, 'At least one file ID is required'),
  recipients: z.array(z.email()).min(1, 'At least one recipient email is required'),
  message: z.string().optional(),
});

export const ProjectQueryParamsSchema = z.object({
  id: z.string().min(1),
});

export const ProjectInviteQueryParamsSchema = z.object({
  id: z.string().min(1),
  page: z.number().positive(),
  limit: z.number().positive().max(100),
  statuses: z.string(),
});

export const FileTagQueryParamsSchema = z.object({
  id: z.string().min(1),
});

export const ReportQueryParamsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type CreateApiKeyRequestBody = z.infer<typeof CreateApiKeyRequestSchema>;
export type UpdateUserRequestBody = z.infer<typeof UpdateUserRequestSchema>;
export type CreateSessionRequestBody = z.infer<typeof CreateSessionRequestSchema>;
export type ProjectFilesRequestBody = z.infer<typeof ProjectFilesRequestSchema>;
export type ProjectSessionsRequestBody = z.infer<typeof ProjectSessionsRequestSchema>;
export type FileTagToggleRequestBody = z.infer<typeof FileTagToggleRequestSchema>;
export type FileTagCreateRequestBody = z.infer<typeof FileTagCreateRequestSchema>;
export type ProjectCreateRequestBody = z.infer<typeof ProjectCreateRequestSchema>;
export type ProjectInviteRequestBody = z.infer<typeof ProjectInviteRequestSchema>;
export type NotebookExportRequestBody = z.infer<typeof NotebookExportRequestSchema>;
export type NotebookCurateRequestBody = z.infer<typeof NotebookCurateRequestSchema>;
export type NotebookDownloadRequestBody = z.infer<typeof NotebookDownloadRequestSchema>;
export type EmailSendRequestBody = z.infer<typeof EmailSendRequestSchema>;
export type NotebookEmailRequestBody = z.infer<typeof NotebookEmailRequestSchema>;
export type FabFileEmailRequestBody = z.infer<typeof FabFileEmailRequestSchema>;

export type ProjectQueryParams = z.infer<typeof ProjectQueryParamsSchema>;
export type ProjectInviteQueryParams = z.infer<typeof ProjectInviteQueryParamsSchema>;
export type FileTagQueryParams = z.infer<typeof FileTagQueryParamsSchema>;
export type ReportQueryParams = z.infer<typeof ReportQueryParamsSchema>;

export function isApiError(error: unknown): error is ApiError {
  return ApiErrorSchema.safeParse(error).success;
}

export function hasStatus(error: unknown): error is { status: number } {
  return typeof error === 'object' && error !== null && 'status' in error && typeof (error as any).status === 'number';
}

export function validateApiRequest<T>(
  schema: z.ZodType<T>,
  data: unknown
): { success: true; data: T } | { success: false; errors: z.ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
}
