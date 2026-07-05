import z from 'zod';
import { IFabFile, KnowledgeType } from '../types';

export const FileGeneratePresignedUrlRequestInput = z.object({
  fileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  /** The path to the file */
  path: z.string().optional(),
  /** SHA-256 content hash for deduplication */
  contentHash: z.string().optional(),
  /** Batch ID for data lake uploads */
  batchId: z.string().optional(),
  /** Original relative path from folder upload */
  relativePath: z.string().optional(),
  /** Tags to apply to the file on creation */
  tags: z.array(z.object({ name: z.string(), strength: z.number() })).optional(),
});
export type FileGeneratePresignedUrlRequestInputType = z.infer<typeof FileGeneratePresignedUrlRequestInput>;

export type FileGeneratePresignedUrlResponseType = {
  url: string;
  fileKey: string;
  fileId: string;
};

export const CreateFabFileRequestInput = z.object({
  type: z.nativeEnum(KnowledgeType),
  fileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  fileContent: z.string().optional(),
  /** Set to true if the file should be publicly accessible */
  public: z.boolean().optional(),
  /** The prefix to use for the file path */
  prefix: z.string().optional(),
});

export type CreateFabFileRequestInputType = z.infer<typeof CreateFabFileRequestInput>;
export type UpdateFabFileRequestInputType = Partial<IFabFile & { fileContent?: string }>;
