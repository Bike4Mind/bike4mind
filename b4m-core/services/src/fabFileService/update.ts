import { Logger } from '@bike4mind/observability';
import {
  FAB_FILE_CONTENT_REWRITE_PATCH,
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IFabFileDocument,
  IFabFileRepository,
  IScopedSettingsRepository,
  IUserDocument,
  KnowledgeType,
  isImageServeable,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { reconcileLakeTags } from './reconcileLakeTags';
import type { LakeConfigAuditAdapters } from '../dataLakeService/recordLakeConfigChange';

import { z } from 'zod';

const updateFabFileSchema = z.object({
  id: z.string(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  fileContent: z.string().optional(),
  type: z.enum(KnowledgeType).optional(),
  system: z.boolean().optional(),
  systemPriority: z.number().min(0).max(999).optional(),
  sessionId: z.string().optional(),
  notes: z.string().optional(),
  primaryTag: z.string().nullable().optional(),
  tags: z
    .array(
      z.object({
        name: z.string(),
        strength: z.number(),
      })
    )
    .optional(),
  error: z.string().nullable().optional(),
});

const EXPIRE_IN_SECONDS = 3600;

type UpdateFabFileParameters = z.infer<typeof updateFabFileSchema>;

interface UpdateFabFileAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    fabFiles: Pick<
      IFabFileRepository,
      'shareable' | 'update' | 'findById' | 'pullTagsByFabFileId' | 'computeDataLakeStats'
    >;
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'setStats' | 'activateIfDraft' | 'find'>;
    // Optional: forwarded to reconcileLakeTags; absent -> createdByUserId + org-rung fallback there.
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake' | 'listActiveByLakes'>;
    // Forwarded to reconcileLakeTags for the admission contract's lever (#1680). Required for the
    // same reason it is there: a door that could omit it would silently skip the contract.
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  };
  /** Forwarded to `reconcileLakeTags`; see its own adapter for what this is for. */
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
  storage: {
    upload: (filePath: string, content: string, metadata?: Record<string, unknown>) => Promise<unknown>;
    generateSignedUrl: (path: string, expireInSeconds: number) => Promise<string>;
    getMetadata?: (path: string) => Promise<{
      size?: number;
      contentType?: string;
      lastModified?: Date;
      etag?: string;
    }>;
  };
  /**
   * The acting principal's org-admin set, when the caller has already resolved it (toAccessContext
   * does). It cannot be read off the user document, so omitting it drops the two org rungs of
   * `canManageLake` from `reconcileLakeTags`' join gate - making this write strictly narrower than
   * the route gate in front of it. Same adapter, for the same reason, as `createFabFile`'s.
   */
  administeredOrgIds?: string[];
}

export const updateFabFile = async (
  user: IUserDocument,
  parameters: UpdateFabFileParameters,
  { db, logger, storage, administeredOrgIds }: UpdateFabFileAdapters
) => {
  const { id, fileContent, ...params } = secureParameters(parameters, updateFabFileSchema);

  // Update-level, not read-level: a read share authorizes viewing this file, never rewriting its
  // bytes, tags or metadata. Unlike findAccessibleById this returns a hydrated document, and the
  // `{ ...fabFile }` spread below would copy Mongoose internals instead of the fields - so
  // normalize first, as updateDocumentSharing does for the same reason.
  const found = await db.fabFiles.shareable.findUpdateAccessById(user, id);

  if (!found) throw new NotFoundError('Invalid ID');

  const fabFile = (
    typeof (found as { toJSON?: unknown }).toJSON === 'function'
      ? (found as unknown as { toJSON: () => IFabFileDocument }).toJSON()
      : found
  ) as IFabFileDocument;

  if (fileContent !== undefined && !fabFile.mimeType.startsWith('image/')) {
    const mimeType = params.mimeType ?? fabFile.mimeType;
    const ext = mime.extension(mimeType) || null;
    const filePath = fabFile.filePath ?? `${uuidv4()}${ext ? `.${ext}` : '.txt'}`;

    await storage.upload(filePath, fileContent, {
      ContentType: mimeType,
    });

    // Get actual file size from S3 after upload
    if (storage.getMetadata) {
      try {
        const metadata = await storage.getMetadata(filePath);
        if (metadata.size !== undefined) {
          fabFile.fileSize = metadata.size;
        }
      } catch (error) {
        Logger.globalInstance.warn('Failed to retrieve file metadata from S3:', error);
      }
    }

    fabFile.fileUrl = await storage.generateSignedUrl(filePath, EXPIRE_IN_SECONDS);
    fabFile.fileUrlExpireAt = new Date(Date.now() + EXPIRE_IN_SECONDS * 1000);

    // The bytes just changed, so any cached extracted length now describes the previous content, and a
    // stale count leaves the pre-send attachment warning silent about a file that no longer fits.
    // Invalidated at the write rather than second-guessed at the read.
    //
    // The shared patch rather than a literal: this is one of several rewrite sites, not "the one place"
    // an earlier version of this comment claimed, and a guard test enumerates them all.
    Object.assign(fabFile, FAB_FILE_CONTENT_REWRITE_PATCH);
  }

  // A tag replacement can join a data lake but can never leave one - see reconcileLakeTags for
  // why. Resolved (and gated) BEFORE the write below, applied after it. This actor also widens
  // what an org admin can do beyond the join gate itself: content tags under an org lake's prefix
  // that were previously force-carried become droppable, and a manageable prefix-arm join now
  // lands in `joins` rather than `statsOnlyJoins` - which can flip a draft lake to active. Both
  // follow from the same fix and are wanted, but the activation is one-way.
  const lakeTags =
    params.tags === undefined
      ? undefined
      : await reconcileLakeTags(
          { userId: user.id, isAdmin: !!user.isAdmin, administeredOrgIds: administeredOrgIds ?? [] },
          id,
          (fabFile.tags ?? []).map(t => t?.name).filter((name): name is string => typeof name === 'string'),
          params.tags,
          {
            db,
            logger,
            fileOwnerUserId: fabFile.userId,
            // Already in hand, so the admission contract grades this file on the target its chunks
            // WERE built with instead of re-fetching it or predicting from policy.
            fileChunkedPassageTokenTarget: fabFile.chunkedPassageTokenTarget,
          }
        );

  const updatedFabFile: Partial<IFabFileDocument> = {
    ...fabFile,
    ...params,
    ...(lakeTags ? { tags: lakeTags.tagsToPersist } : {}),
    systemPriority: params.system && params.systemPriority === undefined ? 999 : params.systemPriority,
    updatedAt: new Date(),
  };

  // An edit (rename/tag/notes/etc.) must not echo back a working GET url for an image
  // that isn't clean (pending scan) or was quarantined (blocked) by upload moderation.
  // Mirrors the withhold-but-keep-metadata pattern in fabFileService/get.ts
  // generateSignedUrl so the client can still render a placeholder instead of the file
  // vanishing. MUST run BEFORE db.fabFiles.update() below - clearing after the write would
  // still persist the stale fileUrl (only the in-memory/returned object was cleared), so a
  // subsequent read would resurrect a working URL for a file that isn't serveable.
  if (!isImageServeable(updatedFabFile)) {
    updatedFabFile.fileUrl = undefined;
    updatedFabFile.fileUrlExpireAt = undefined;
  }

  await db.fabFiles.update(updatedFabFile);

  // A whole-array write can never leave a lake (see reconcileLakeTags), so tagsToPersist - already
  // assigned into updatedFabFile above - is always the true final array; commit() only needs to
  // recompute stats for any new join.
  if (lakeTags) {
    await lakeTags.commit();
  }

  return updatedFabFile;
};
