import { updateFileSharingState } from '@server/managers/fabFileManager';
import { updateSessionSharingState } from '@server/managers/sessionManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { logEvent } from '@server/utils/analyticsLog';
import { ProjectEvents } from '@bike4mind/common';
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
    const validatedData = UpdateSharingRequestSchema.parse(req.body);
    const { isGlobalRead, isGlobalWrite } = validatedData;

    if (!type || !id || !req.ability) {
      throw new NotFoundError(`${type || 'Document'} not found`);
    }

    // Dispatch to the appropriate manager
    const handler = {
      files: updateFileSharingState,
      sessions: updateSessionSharingState,
    }[type];

    if (!handler) {
      throw new NotFoundError(`Unrecognized type ${type}`);
    }

    console.log(`Updating sharing state for ${type} ${id} to ${isGlobalRead} ${isGlobalWrite}`);
    const updatedDocument = await handler(id, { isGlobalRead, isGlobalWrite }, req.ability);
    if (!updatedDocument) {
      throw new NotFoundError(`${type} not found or unable to update`);
    }

    // Log sharing update event
    if (type === 'projects') {
      await logEvent(
        {
          userId: req.user.id,
          type: ProjectEvents.UPDATE_SHARING,
          metadata: {
            projectId: id,
            projectName: (updatedDocument as { name: string }).name,
            newValue: isGlobalRead || isGlobalWrite,
          },
        },
        { ability: req.ability }
      );
    }

    return res.json(updatedDocument);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
