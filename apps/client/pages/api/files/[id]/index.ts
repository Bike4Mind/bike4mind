import { FileEvents, IFabFile, KnowledgeType } from '@bike4mind/common';
import {
  changeStorageSize,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileChunkRepository,
  fabFileRepository,
  fileTagRepository,
  adminSettingsRepository,
  scopedSettingsRepository,
  sessionRepository,
  userRepository,
  withTransaction,
  User,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { recomputeStatsForLakeTags } from '@server/dataLakes/recomputeStatsForLakeTags';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { getFilesStorage } from '@server/utils/storage';
import { loadAccessibleFabFile } from '@server/files/loadAccessibleFabFile';
import { Request } from 'express';
import { isValidObjectId } from '@server/utils/objectId';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeMembershipAuditDb } from '@server/dataLakes/lakeMembershipAuditDb';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { assertDataLakeTagWriteScope, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';

const handler = baseApi()
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    req.logger.updateMetadata({ userId: req.user.id, fileId: req.query.id });
    return res.json(await loadAccessibleFabFile(req, req.query.id));
  })
  /**
   * Update FabFile by ID
   */
  .put(async (req: Request<{}, {}, Partial<IFabFile> & { fileContent: string }, { id: string }>, res) => {
    const userId = req.user.id;
    const fabFileId = req.query.id;

    req.logger.updateMetadata({ userId, fileId: fabFileId });

    // Same guard the DELETE branch below carries.
    if (!isValidObjectId(fabFileId)) {
      return res.status(404).json({ msg: 'File not found' });
    }

    // Data-lake membership is conferred by the lake's `datalake:*` meta-tag. Applying one is a
    // WRITE into that lake, so gate it with the same creator/admin check the remove path uses -
    // otherwise a read-only member could inject files via Send-to-Data-Lake.
    //
    // A `fileTagPrefix` content tag is membership too, but this route-level gate is NOT extended
    // to cover it: it has no resolved file, so it cannot know the owner a prefix-arm join is
    // anchored to. `reconcileLakeTags` (inside `updateFabFile` below) gates that join - a whole-
    // array write can only ever join or preserve membership through either mechanism, never
    // leave one; see that function's docstring.
    const candidateTagNames = [
      ...(req.body.tags?.map(t => t.name) ?? []),
      ...(req.body.primaryTag ? [req.body.primaryTag] : []),
    ];
    await assertDataLakeTagWriteScope(req, candidateTagNames);
    // No `members` here: this is a whole-array write, so the payload cannot distinguish a join
    // from a resend, and `reconcileLakeTags` (inside `updateFabFile` below) runs the admission
    // contract over every lake this write actually JOINS - meta-tag and prefix-arm alike - with the
    // file already in hand. Naming members here would re-read the file to check a strict subset.
    // Full actor, not a `{ userId, isAdmin }` literal: `canManageLake`'s org-admin rung reads
    // `administeredOrgIds`, which cannot be derived from the user document, so a literal here
    // makes this gate strictly narrower than every other lake-management gate in the app.
    const ctx = await toAccessContext(req);
    await dataLakeService.assertCanWriteDataLakeTags(ctx, candidateTagNames, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        adminSettings: adminSettingsRepository,
        scopedSettings: scopedSettingsRepository,
      },
      logger: req.logger,
    });

    const updatedFabFile = await withTransaction(async () => {
      try {
        return await fabFilesService.updateFabFile(
          req.user,
          {
            id: fabFileId,
            type: req.body.type as KnowledgeType,
            fileName: req.body.fileName as string,
            mimeType: req.body.mimeType as string,
            fileContent: req.body.fileContent,
            system: req.body.system,
            systemPriority: req.body.systemPriority,
            sessionId: req.body.sessionId,
            notes: req.body.notes,
            // Pass through null so "unset primary" clears the field; ?? undefined
            // would coalesce null to undefined and get dropped from the $set.
            primaryTag: req.body.primaryTag,
            tags: req.body.tags,
            error: req.body.error,
          },
          {
            db: {
              fabFiles: fabFileRepository,
              dataLakes: dataLakeRepository,
              dataLakeAccessGrants: dataLakeAccessGrantRepository,
              // `lakeConfigAuditDb` carries `adminSettings`, which is also what the admission
              // contract's lever resolves from; only `scopedSettings` is additional here.
              ...lakeConfigAuditDb,
              ...lakeMembershipAuditDb,
              scopedSettings: scopedSettingsRepository,
            },
            // `reconcileLakeTags` re-gates every lake this write JOINS, so its actor has to stay as
            // wide as the prologue gate above - the org rungs of `canManageLake` cannot be derived
            // from the user document this service is handed.
            administeredOrgIds: ctx.administeredOrgIds,
            // Same reason the DELETE handler below attaches one: a tag write here can flip a draft
            // lake to active, and this route accepts a `b4m_live_` key.
            auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
            // Covers the fileTagPrefix membership arm the prologue gate above cannot see (it has no
            // resolved file owner) - called only when reconcileLakeTags actually finds a prefix-arm
            // join. Mirrors the toggle route's identical gate.
            assertWriteScope: () => assertDataLakeWriteScope(req),
            logger: req.logger,
            storage: {
              upload: (filepath, content, option) => {
                return getFilesStorage().upload(content, filepath, option);
              },
              generateSignedUrl: (path: string, expireInSeconds: number) =>
                getFilesStorage().getSignedUrl(path, undefined, { expiresIn: expireInSeconds }),
            },
          }
        );
      } catch (error) {
        req.logger.error('Error updating fab file:', { error, fileId: fabFileId });
        throw error;
      }
    });

    await logEvent(
      {
        userId,
        type: FileEvents.UPDATE_FILE,
        metadata: { fileId: fabFileId, fileContent: updatedFabFile.filePath ?? '' },
      },
      { ability: req.ability }
    );

    return res.json(updatedFabFile);
  })
  /**
   * Delete FabFile by ID
   */
  .delete(async (req: Request<{}, {}, {}, { id: string }>, res) => {
    const userId = req.user.id;
    const fabFileId = req.query.id;

    req.logger.updateMetadata({ userId, fileId: fabFileId });

    if (!isValidObjectId(fabFileId)) {
      return res.status(404).json({ msg: 'File not found' });
    }

    // Only touch tag activity for owned files (shared file "delete" = unshare, not removal)
    const fabFile = await fabFileRepository.findById(fabFileId);
    const isOwned = fabFile?.userId === userId;
    if (isOwned && fabFile?.tags?.length) {
      for (const tag of fabFile.tags) {
        try {
          if (tag?.name) {
            await fileTagRepository.touchLastActivityBy({ name: tag.name, userId });
          }
        } catch (tagError) {
          req.logger.error('Error touching tag activity during single file delete:', { tagError, tag });
        }
      }
    }

    let sizeToDeduct = 0;

    const deleteAction = await withTransaction(async session => {
      const result = await fabFilesService.deleteFabFile(
        userId,
        { id: fabFileId },
        {
          db: {
            fabFiles: fabFileRepository,
            users: userRepository,
            sessions: sessionRepository,
            fabFileChunks: fabFileChunkRepository,
            dataLakes: dataLakeRepository,
            ...lakeMembershipAuditDb,
          },
          storage: getFilesStorage(),
          onDeleteComplete: async (_fabFile, size) => {
            sizeToDeduct = size;
          },
          searchIndex: selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined,
          logger: req.logger,
          // Same reason the tag-write handler above attaches one: this route accepts a `b4m_live_`
          // key, and the resulting 'removed' rows must name the key, not the human it acts for.
          auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
        }
      );

      if (result.action === 'deleted') {
        await logEvent(
          { userId, type: FileEvents.DELETE_FILE, metadata: { fileId: fabFileId } },
          { ability: req.ability, session }
        );
      } else if (result.action === 'unshared') {
        await logEvent(
          {
            userId,
            type: FileEvents.UNSHARE_FILE,
            metadata: { fileId: fabFileId, ownerId: result.fabFile?.userId ?? '' },
          },
          { ability: req.ability, session }
        );
      }

      return result.action;
    });

    // Deduct storage size after successful deletion
    if (sizeToDeduct > 0) {
      try {
        await withTransaction(async session => {
          const user = await User.findById(userId).session(session);
          if (user) {
            await changeStorageSize(user, -sizeToDeduct);
            await user.save({ session });
          }
        });
      } catch (error) {
        req.logger.error('Error updating user storage size after single file delete:', {
          error: error instanceof Error ? error.message : 'Unknown error',
          sizeToDeduct,
        });
      }
    }

    // After the transaction, so the aggregation sees the committed `deletedAt`. The shared helper
    // also backs bulk-delete; see it for why only the 'deleted' outcome moves lake membership.
    if (deleteAction === 'deleted') {
      await recomputeStatsForLakeTags(
        (fabFile?.tags ?? []).map(tag => tag?.name),
        {
          logger: req.logger,
          actor: {
            userId: req.user.id,
            isAdmin: !!req.user.isAdmin,
            auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
          },
        }
      );
    }

    return res.json({
      msg: 'Fab file deleted',
      action: fabFilesService.toPublicDeleteAction(deleteAction),
    });
  });

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    externalResolver: true,
  },
};

export default handler;
