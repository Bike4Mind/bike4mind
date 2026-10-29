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
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { Request, Response } from 'express';

const revokeBodySchema = z.object({
  userId: z.string(),
  projectId: z.string().optional(),
});

// Next.js passes query params as string | string[]; widen the interface so the
// typeof guard below is honest rather than dead per the declared type.
interface SharingParams {
  id: string | string[];
  type: string | string[];
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
    // Wrap in a transaction so the guarded doc write and revokeFromProject's side effects are atomic:
    // a ConcurrencyConflictError from a racing grant rolls the whole revoke back (mirrors accept).
    const document = await withTransaction(() =>
      sharingService.revoke(
        req.user.id,
        // 'projects' included: the Members panel posts to /api/projects/<id>/revokeSharing, which
        // lands on revoke's projects arm. The narrower cast excluded the one type that runs the
        // revokeFromProject cascade.
        { ...body, id, type: type as 'files' | 'sessions' | 'projects' },
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

    // After the commit, outside its session (see cleanUpDeletedFileReferences). A projectId-scoped
    // revoke drops one project's grant only, so it leaves the user's own references alone.
    if (type === 'files' && !body.projectId) {
      await sharingService.cleanUpRevokedFileReferences(id, body.userId, {
        db: { users: userRepository, fabFiles: fabFileRepository, sessions: sessionRepository },
        // Imported at call time, like the session routes: the resolver's graph reaches the Mongoose models.
        resolveAttachmentLakeAccess: async user =>
          (await import('@server/dataLakes/attachmentLakeAccess')).createAttachmentLakeAccess(user, req.logger, {
            requireCompleteView: true,
          })(),
        logger: req.logger,
      });
    }

    return res.json(document);
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
