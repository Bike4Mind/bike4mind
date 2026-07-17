import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { sharingService } from '@bike4mind/services';
import { sessionRepository, fabFileRepository } from '@bike4mind/database';
import { z } from 'zod';

interface SharingParams {
  id?: string;
  type?: string;
}

const UpdateSharingRequestSchema = z.object({
  isGlobalRead: z.boolean(),
  isGlobalWrite: z.boolean(),
});

// This endpoint is dispatched at different paths depending on the document type.
const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, SharingParams>(async (req, res) => {
    const { type, id } = req.query;
    const { isGlobalRead, isGlobalWrite } = UpdateSharingRequestSchema.parse(req.body);

    if (!id) {
      throw new NotFoundError(`${type || 'Document'} not found`);
    }
    if (type !== 'files' && type !== 'sessions') {
      throw new NotFoundError(`Unrecognized type ${type}`);
    }

    // Write-access authorization lives in the service (shareable.findUpdateAccessById).
    const updatedDocument = await sharingService.updateDocumentSharing(
      req.user,
      { id, type, isGlobalRead, isGlobalWrite },
      { db: { sessions: sessionRepository, fabFiles: fabFileRepository } }
    );

    return res.json(updatedDocument);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
