import type { ChatSessionSummary } from '@shared/chat';

/**
 * The folder to remember after a renderer-driven bind, or null. Taken from the session main
 * settled on rather than the request, so the entry is the resolved project root. Only a request
 * that names a directory counts: a branch-only update, or a spawned session inheriting its
 * parent's folder, is not the user choosing a folder.
 */
export function folderToRemember(
  request: { directory?: string } | undefined,
  result: { ok: true; session: ChatSessionSummary } | { ok: false }
): string | null {
  if (!result.ok || !request?.directory) return null;
  return result.session.project?.directory ?? null;
}
