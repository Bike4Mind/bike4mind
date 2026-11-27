import type { SessionStore } from '../SessionStore';
import type { StudioLiveService } from './StudioLiveService';
import type { StudioGenerationService } from './generation/StudioGenerationService';

/** Deletion and paid admission share one family gate through the final storage change. */
export function createStudioSessionDeletion(
  sessions: SessionStore,
  live: Pick<StudioLiveService, 'assertDeletable'>,
  generation: Pick<StudioGenerationService, 'withWorkspaceLock'>
) {
  return async <T>(sessionId: string, remove: () => Promise<T>): Promise<T> => {
    const scope = sessions.scopeKey();
    if (!scope) return remove();
    const identity = await sessions.resolveStudioWorkspace(sessionId, scope);
    if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
    if (!identity) {
      if (await sessions.get(sessionId)) throw new Error('Studio workspace unavailable.');
      return remove();
    }
    return generation.withWorkspaceLock(scope, identity.workspaceId, async () => {
      const current = await sessions.resolveStudioWorkspace(sessionId, scope);
      if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
      if (current && current.workspaceId !== identity.workspaceId) throw new Error('Studio workspace changed.');
      if (current) await live.assertDeletable(sessionId);
      if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
      return remove();
    });
  };
}
