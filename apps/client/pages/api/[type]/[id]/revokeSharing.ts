import { z } from 'zod';
import { IShareableDocument } from '@bike4mind/common';
import { fabFileRepository, projectRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { Request, Response } from 'express';

const revokeBodySchema = z.object({
  userId: z.string(),
  projectId: z.string().optional(),
});

interface SharingParams {
  id: string;
  type: string;
}

// This endpoint is dispatched at different paths depending on the document type.
const handler = baseApi().use(
  async (req: Request<unknown, {}, IShareableDocument, SharingParams>, res: Response<IShareableDocument>) => {
    const { type, id } = req.query;
    if (typeof id !== 'string' || !id) {
      throw new BadRequestError('Invalid document id');
    }
    const body = revokeBodySchema.parse(req.body);

    // id and type come after the body spread so URL params win over any body field with the same name.
    const document = await sharingService.revoke(
      req.user.id,
      { ...body, id, type: type as 'files' | 'sessions' },
      {
        db: {
          sessions: sessionRepository,
          fabFiles: fabFileRepository,
          projects: projectRepository,
          users: userRepository,
        },
      }
    );

    return res.json(document);
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
