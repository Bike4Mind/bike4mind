import '@bike4mind/server-utils/lib/settings/registerContributedSettings';
import {
  applyWorkspaceSessionSettings,
  redactSessionForClient,
  stripSurfaceOwnedFields,
  type sessionGetContract,
} from '@bike4mind/common';
import { sessionService } from '@bike4mind/services';
import { sessionRepository, userRepository } from '@bike4mind/database';
import { requesterScopedUsers } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { premiumWorkspaceSessionSettings } from '@bike4mind/server-utils/premium-generated/premiumWorkspaceSessionSettings.generated';
import type { ContractRequest } from '@server/middlewares/defineNextRoute';
import type { Response } from 'express';

export async function readSession(req: ContractRequest<typeof sessionGetContract>, res: Response) {
  const session = await sessionService.getSession(
    req.user!.id,
    { id: req.validatedParams.id },
    { db: { sessions: sessionRepository, users: requesterScopedUsers(req, userRepository) } }
  );

  const doc = session as typeof session & { toJSON?: () => typeof session };
  const plain = typeof doc.toJSON === 'function' ? doc.toJSON() : session;
  try {
    const effective = await applyWorkspaceSessionSettings(
      plain,
      { user: req.user, logger: req.logger },
      premiumWorkspaceSessionSettings
    );
    return res.json(redactSessionForClient(effective));
  } catch (error) {
    req.logger.warn('Workspace session settings unavailable for GET; returning without owned fields', error);
    // Stored values are not authoritative when the workspace resolver is unavailable.
    const fallback = stripSurfaceOwnedFields(plain, premiumWorkspaceSessionSettings, { surface: plain.surface });
    return res.json(redactSessionForClient(fallback));
  }
}
