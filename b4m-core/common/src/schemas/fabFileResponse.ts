import * as z from 'zod';
import type { IFabFileDocument } from '../types/entities/FabFileTypes';
import { passthroughShape } from './responseShape';
import { groupShareResponseSchema, userShareResponseSchema } from './shareResponse';

// Held to IFabFileDocument: a new IFabFile field fails the build here until it is listed. This is
// the key boundary only - it strips keys it does not list, it never withholds one. `users` and
// `groups` are typed below instead of passed through.
const FAB_FILE_RESPONSE_FIELDS = {
  isGlobalRead: true,
  isGlobalWrite: true,
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  fileName: true,
  fileNameLower: true,
  fileSize: true,
  extractedCharCount: true,
  filePath: true,
  mimeType: true,
  organizationId: true,
  notes: true,
  type: true,
  public: true,
  chunkCount: true,
  vectorizedChunkCount: true,
  chunkedCharCount: true,
  maxChunkCharLength: true,
  embeddedChunkCount: true,
  embeddedCharCount: true,
  isChunking: true,
  chunkClaimedAt: true,
  chunkClaimConfirmedAt: true,
  chunked: true,
  chunkedPassageTokenTarget: true,
  chunkRebuildRequestedAt: true,
  chunkStallReason: true,
  noExtractableTextAt: true,
  chunkPolicyConflict: true,
  isVectorizing: true,
  vectorized: true,
  embeddingModel: true,
  chunkEmbeddingModelStampedAt: true,
  vectorizeEnqueueFailedAt: true,
  system: true,
  systemPriority: true,
  tags: true,
  primaryTag: true,
  status: true,
  moderationStatus: true,
  blockReason: true,
  moderationClaimedAt: true,
  moderationETag: true,
  moderationRevision: true,
  clientUpload: true,
  uploadRejectedAt: true,
  storageChargedAt: true,
  moderationAttempts: true,
  moderationLastAttemptAt: true,
  error: true,
  fileUrl: true,
  presignedUrl: true,
  fileUrlExpireAt: true,
  sourceType: true,
  sourceMetadata: true,
  derivedFrom: true,
  automaticallyProcessed: true,
  dataLakeMetadata: true,
  contentHash: true,
  serverTextHash: true,
  batchId: true,
  relativePath: true,
  documentDate: true,
  documentDateSource: true,
  driveFileId: true,
  driveModifiedTime: true,
  driveMd5Checksum: true,
  sourceLakeId: true,
  driveConnectionId: true,
  githubConnectionId: true,
  githubPath: true,
  githubBlobSha: true,
  supersededInLakes: true,
  sessionId: true,
  archivedAt: true,
  dispatchedNotifications: true,
  versions: true,
  deletedAt: true,
} as const satisfies Record<Exclude<keyof IFabFileDocument, 'users' | 'groups'>, true>;

/** A file as listed by the SPA project files route. */
export const fabFileResponseSchema = z.object({
  ...passthroughShape(FAB_FILE_RESPONSE_FIELDS),
  users: z.array(userShareResponseSchema).optional(),
  groups: z.array(groupShareResponseSchema).optional(),
});

export const fabFileListResponseSchema = z.array(fabFileResponseSchema);

/** POST /api/files/createFabFile: the created file, plus the public media URL for an admin modal-media upload. */
export const createdFabFileResponseSchema = fabFileResponseSchema.extend({ mediaUrl: z.string().optional() });

/**
 * POST /api/files/tags/toggle: each toggled file, plus how many lakes the call joined it to solely
 * by a fileTagPrefix content tag (a count, never the lakes themselves).
 */
export const toggledFabFileListResponseSchema = z.array(
  fabFileResponseSchema.extend({ prefixArmJoinedLakeCount: z.number().optional() })
);
