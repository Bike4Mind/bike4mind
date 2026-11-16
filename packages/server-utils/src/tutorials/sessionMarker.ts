import { sessionRepository } from '@bike4mind/database';

/** Shared by the route deps (coreDeps) and the chat path (chatTurns), which must not load coreDeps. */
export async function setCoreSessionMarker(sessionId: string, userId: string, moduleId: string | null) {
  if (!(await sessionRepository.findByIdAndUserId(sessionId, userId))) return;
  await sessionRepository.update({ id: sessionId, tutorial: moduleId ? { owner: 'core', moduleId } : null });
}
