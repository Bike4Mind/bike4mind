import { ISessionRepository, surfaceOwnedFields, type WorkspaceSessionSettingsTable } from '@bike4mind/common';
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
  /** Fields the source workspace owns, unset on the way out; absent = none. */
  workspaceSessionSettings?: WorkspaceSessionSettingsTable;
};

/**
 * Moves the caller's own session into another registered workspace by rewriting `surface` and
 * unsetting the fields the source workspace owns (`workspaceSessionSettings`). Owner only: a share grant does not let you relocate someone else's notebook.
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
  const updated =
    target === null
      ? await db.sessions.update({ id }, { unset: ['surface', ...ownedFields] })
      : ownedFields.length > 0
        ? await db.sessions.update({ id, surface: target }, { unset: ownedFields })
        : await db.sessions.update({ id, surface: target });
  if (!updated) throw new NotFoundError('Session not found');
  return updated;
};
