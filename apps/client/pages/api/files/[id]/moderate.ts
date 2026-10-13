import { FabFile } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FILES_WRITE_SCOPES } from '@server/files/fileScopes';
import {
  claimModerationScan,
  releaseModerationClaim,
  scanUploadedObject,
  toVerdictPatch,
  writeModerationVerdict,
} from '@server/s3/moderationScan';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';
import type { Request, Response } from 'express';

/**
 * On-demand moderation scan for a file the caller has just uploaded.
 *
 * Uploads go straight to S3 and are only scanned when the ObjectCreated event fires, a few seconds
 * later. A caller that needs the file serveable right away (a brushed edit mask, uploaded and
 * dispatched in one user action) calls this after its PUT completes to run that same scan now.
 *
 * Shares the S3 handler's compare-and-swap claim, so the two never both scan or overwrite each
 * other's verdict. Fail-closed throughout: a transient scanner failure hands the claim back and
 * reports 'pending', never 'blocked'. If the S3 event has already fired it lost the claim to this
 * call and will not be retried, so only the rescue sweep recovers the file after that.
 */
const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES }).post(
  asyncHandler(async (req: Request, res: Response) => {
    const fabFileId = String((req.query as { id?: string }).id ?? '');
    const fabFile = await FabFile.findById(fabFileId);
    // Same 404 for missing and not-owned so the route doesn't leak which files exist.
    if (!fabFile || fabFile.userId !== req.user.id) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!fabFile.filePath) {
      return res.status(400).json({ error: 'File has no storage path' });
    }

    if (fabFile.moderationStatus === 'clean' || fabFile.moderationStatus === 'blocked') {
      return res.json({ moderationStatus: fabFile.moderationStatus });
    }

    const claimedAt = new Date();
    const claimed = await claimModerationScan(fabFile._id, claimedAt);
    // Lost the claim: the S3 event (or an earlier call) owns the verdict and will land it.
    if (!claimed) return res.json({ moderationStatus: 'pending' });

    try {
      const result = await scanUploadedObject({ fabFile, objectKey: fabFile.filePath, logger: req.logger });
      // The byte-sniffed type rides in the guarded write: the S3 handler persists it through its own
      // save, but it will have lost the claim and skipped the scan by now.
      const landed = await writeModerationVerdict(fabFile._id, claimedAt, {
        ...toVerdictPatch(result),
        ...(result.correctedMimeType && result.correctedMimeType !== fabFile.mimeType
          ? { mimeType: result.correctedMimeType }
          : {}),
      });
      if (!landed) return res.json({ moderationStatus: 'pending' });

      // The S3 handler's lost-claim branch reports 'pending' for a scan still in flight, so this
      // is the only place listeners learn the final verdict.
      await sendToClient(req.user.id, Resource.websocket.managementEndpoint, {
        action: 'image_moderation_status',
        fabFileId: fabFile.id,
        moderationStatus: result.moderationStatus,
      }).catch(error =>
        req.logger.warn('Could not send image_moderation_status', {
          fabFileId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return res.json({ moderationStatus: result.moderationStatus });
    } catch (error) {
      req.logger.warn('On-demand moderation scan failed; leaving the file pending', {
        fabFileId,
        error: error instanceof Error ? error.message : String(error),
      });
      await releaseModerationClaim(fabFile._id, claimedAt);
      return res.json({ moderationStatus: 'pending' });
    }
  })
);

export default handler;
