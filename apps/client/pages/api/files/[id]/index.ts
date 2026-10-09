import { IFabFile, KnowledgeType } from '@bike4mind/common';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  adminSettingsRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { deleteFileForUser } from '@server/files/deleteFileForUser';
import { updateFileForUser } from '@server/files/updateFileForUser';
import { loadAccessibleFabFile } from '@server/files/loadAccessibleFabFile';
import { assertFilesReadScope, assertFilesWriteScope, FILES_READ_OR_WRITE_SCOPES } from '@server/files/fileScopes';
import { Request } from 'express';
import { isValidObjectId } from '@server/utils/objectId';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { assertDataLakeTagWriteScope } from '@server/dataLakes/dataLakeScopes';

// baseApi's scope gate is per route, so it admits either files scope and each method asserts its own.
const handler = baseApi({ requiredScopes: FILES_READ_OR_WRITE_SCOPES })
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    assertFilesReadScope(req);
    req.logger.updateMetadata({ userId: req.user.id, fileId: req.query.id });
    return res.json(await loadAccessibleFabFile(req, req.query.id));
  })
  /**
   * Update FabFile by ID
   */
  .put(async (req: Request<{}, {}, Partial<IFabFile> & { fileContent: string }, { id: string }>, res) => {
    assertFilesWriteScope(req);
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

    const updatedFabFile = await updateFileForUser(
      req,
      ctx.administeredOrgIds,
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
        error: req.body.error,
      },
      {
        // Pass through null so "unset primary" clears the field; ?? undefined
        // would coalesce null to undefined and get dropped from the $set.
        primaryTag: req.body.primaryTag,
        tags: req.body.tags,
      }
    );

    return res.json(updatedFabFile);
  })
  /**
   * Delete FabFile by ID
   */
  .delete(async (req: Request<{}, {}, {}, { id: string }>, res) => {
    assertFilesWriteScope(req);
    const userId = req.user.id;
    const fabFileId = req.query.id;

    req.logger.updateMetadata({ userId, fileId: fabFileId });

    if (!isValidObjectId(fabFileId)) {
      return res.status(404).json({ msg: 'File not found' });
    }

    const deleteAction = await deleteFileForUser(req, fabFileId);

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
