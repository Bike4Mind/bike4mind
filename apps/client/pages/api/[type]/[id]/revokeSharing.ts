import { z } from 'zod';
import { IShareableDocument } from '@bike4mind/common';
import {
  fabFileRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
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
    const body = revokeBodySchema.parse(req.body);

    // Wrap in a transaction so the guarded doc write and revokeFromProject's side effects are atomic:
    // a ConcurrencyConflictError from a racing grant rolls the whole revoke back (mirrors accept).
    const document = await withTransaction(() =>
      sharingService.revoke(
        req.user.id,
        { id, type: type as 'files' | 'sessions', ...body },
        {
          db: {
            sessions: sessionRepository,
            fabFiles: fabFileRepository,
            projects: projectRepository,
            users: userRepository,
          },
        }
      )
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
