import { useTutorialStore } from './useTutorialStore';

/**
 * True while a tutorial module runs, so a surface can stay out of the coach's way. Given a session id, only
 * the tutorial's own session counts: `active` outlives a switch to another session, which is not a tutorial.
 * Outside a TutorialHostProvider, pass the host's `apiBase`.
 */
export const useTutorialActive = (sessionId?: string | null, apiBase?: string): boolean =>
  useTutorialStore(state => state.active !== null && (!sessionId || state.active.sessionId === sessionId), apiBase);
