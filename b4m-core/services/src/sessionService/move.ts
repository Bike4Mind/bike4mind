import {
  ISessionRepository,
  surfaceOwnedFields,
  userSetSessionFields,
  type WorkspaceSessionSettingsTable,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { assertSurfaceTransition, type ResolveSurfaceAccess } from './surfaceTransition';

const moveSessionSchema = z.object({
  id: z.string(),
  targetSurface: z.string().nullable(),
});

type MoveSessionParameters = z.infer<typeof moveSessionSchema>;

type MoveSessionAdapters = {
  db: {
    sessions: Pick<ISessionRepository, 'findByIdAndUserId' | 'update'>;
  };
  resolveSurfaceAccess?: ResolveSurfaceAccess;
  /** Fields the source workspace owns, unset on the way out. */
  workspaceSessionSettings: WorkspaceSessionSettingsTable;
};

/**
 * Moves the caller's own session into another registered workspace by rewriting `surface` and
 * unsetting the fields the source workspace owns (`workspaceSessionSettings`). Owner only: a share grant
 * does not let you relocate someone else's notebook.
 */
export const moveSession = async (userId: string, parameters: MoveSessionParameters, adapters: MoveSessionAdapters) => {
  const { db } = adapters;
  const { id, targetSurface } = secureParameters(parameters, moveSessionSchema);

  const session = await db.sessions.findByIdAndUserId(id, userId);
  if (!session) throw new NotFoundError('Session not found');

  const target = await assertSurfaceTransition(session.surface, targetSurface, adapters.resolveSurfaceAccess);
  if (target === (session.surface || null)) return session;

  // The main list is "no surface": unset rather than store null, matching sessions that never had one.
  const ownedFields = surfaceOwnedFields(session, adapters.workspaceSessionSettings);
  if (target === null) {
    const updated = await db.sessions.update({ id }, { unset: ['surface', ...ownedFields] });
    if (!updated) throw new NotFoundError('Session not found');
    return updated;
  }

  // A session created before userSetFields existed carries none, so record what the source surface leaves
  // to the user before entering a workspace; otherwise the move back out would unset those values as owned.
  const userSetFields = userSetSessionFields(session, adapters.workspaceSessionSettings, session.userSetFields);
  const recordUserSet = userSetFields.some(field => !session.userSetFields?.includes(field));
  const data = { id, surface: target, ...(recordUserSet ? { userSetFields } : {}) };
  const updated =
    ownedFields.length > 0 ? await db.sessions.update(data, { unset: ownedFields }) : await db.sessions.update(data);
  if (!updated) throw new NotFoundError('Session not found');
  return updated;
};
