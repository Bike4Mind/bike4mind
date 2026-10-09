import { useLocation } from '@tanstack/react-router';
import { useSessions } from '@client/app/contexts/SessionsContext';

/**
 * The notebook a browser surface (Data Lake, research tasks, the Knowledge editor) may attach
 * a file to: the one on screen, or none.
 *
 * `currentSessionId` is app-level state that outlives the notebook route, and the file browser
 * opens over any page - so trusting it alone would persist (and project-propagate) into a
 * notebook the user is not looking at. Both notebook-shell children count (router.tsx):
 * - `/new`: on screen with the current id, normally null - an attach lands in the '' workbench
 *   bucket, which the first send reads into the new session.
 * - `/notebooks/$id`: on screen only once `currentSessionId` matches the route, which also
 *   closes the A -> B switch window before changeSession settles (SessionsContext).
 */
export type ActiveNotebook = { onScreen: false } | { onScreen: true; sessionId: string | null };

const NOTEBOOK_PATH = /^\/notebooks\/([^/]+)\/?$/;

export function useActiveNotebook(): ActiveNotebook {
  const { currentSessionId } = useSessions();
  const pathname = useLocation({ select: location => location.pathname });

  if (pathname === '/new') return { onScreen: true, sessionId: currentSessionId };

  const routeSessionId = NOTEBOOK_PATH.exec(pathname)?.[1];
  if (routeSessionId && routeSessionId === currentSessionId) return { onScreen: true, sessionId: routeSessionId };

  return { onScreen: false };
}
