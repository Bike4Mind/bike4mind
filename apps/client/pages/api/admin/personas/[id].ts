import type { Request, Response } from 'express';
import { ConflictError } from '@bike4mind/common';
import { adminAuditLogRepository, userRepository } from '@bike4mind/database';
import { adminAuditService } from '@bike4mind/services';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { hardDeleteUser } from '@server/services/hardDeleteUser';
import {
  PERSONA_ADMIN_KEY_HEADER,
  isValidPersonaAdminKey,
  readPersonaAdminKey,
} from '@server/personas/personaAdminKey';
import {
  PERSONA_KEY_ACTOR,
  isPersonaAccount,
  personaAuditContext,
  personaAuditTarget,
  revokePersonaSessions,
} from '@server/personas/personaAccounts';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

/**
 * DELETE /api/admin/personas/:id - hard-delete a persona minted by POST /api/admin/personas, with
 * the same PERSONA_ADMIN_KEY header. Refuses (404, indistinguishable from a missing id) any account
 * that is not flagged isPersona, does not carry a persona username, or has admin access, so the key
 * can never delete a real user. Signs the persona out everywhere first, then deletes through the
 * shared hardDeleteUser path with the audit entry in the delete's transaction.
 */
const handler = baseApi({ auth: false })
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000, bucket: 'admin-personas-delete' }))
  .delete(
    asyncHandler(async (req: Request, res: Response) => {
      const expectedKey = readPersonaAdminKey();
      if (!expectedKey) return res.status(404).json({ error: 'Not found' });
      if (!isValidPersonaAdminKey(req.headers[PERSONA_ADMIN_KEY_HEADER], expectedKey)) {
        return res.status(401).json({ error: 'Invalid persona admin key' });
      }

      const id = typeof req.query.id === 'string' ? req.query.id : '';
      const notFound = () => res.status(404).json({ error: 'No persona account with that id' });
      if (!OBJECT_ID_PATTERN.test(id)) return notFound();
      const target = await userRepository.findById(id);
      if (!isPersonaAccount(target)) return notFound();

      await revokePersonaSessions(id, req.logger);
      await hardDeleteUser(
        id,
        {
          deletedBy: PERSONA_KEY_ACTOR.name,
          initiatedBy: 'admin',
          logger: req.logger,
          // Re-checked inside the transaction, in case the account changed since the read above.
          assertInTransaction: async () => {
            if (!isPersonaAccount(await userRepository.findById(id))) {
              throw new ConflictError('This account is no longer a persona account');
            }
          },
          recordInTransaction: async deleted => {
            await adminAuditService.recordAdminAction(
              {
                action: 'user.persona.deleted',
                actor: PERSONA_KEY_ACTOR,
                target: personaAuditTarget(deleted ?? target!),
                summary: `deleted test persona ${(deleted ?? target!).username}`,
                context: personaAuditContext(req),
              },
              { db: { adminAuditLog: adminAuditLogRepository }, logger: req.logger }
            );
          },
        },
        users => users.delete(id)
      );

      return res.status(200).json({ deleted: true, id });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
