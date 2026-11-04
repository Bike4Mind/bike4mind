export type OrchestratorViewId = 'tavern' | 'board' | 'table';
export const ORCHESTRATOR_VIEWS: readonly OrchestratorViewId[] = ['tavern', 'board', 'table'];

export type SessionSurface = 'chat' | 'orchestrate';

const SURFACE_KEY = 'b4m.orchestrator.surface.';
const VIEW_KEY = 'b4m.orchestrator.view.';
const DOCK_OPEN_KEY = 'b4m.orchestrator.dockOpen';
const INTRO_SEEN_KEY = 'b4m.orchestrator.introSeen';
const FINALE_SEEN_KEY = 'b4m.orchestrator.finaleSeen.';

/** Storage can be blocked or full; every preference then just falls back to its default. */
function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered across runs; the in-memory state still holds for this one.
  }
}

export function readSurface(sessionId: string): SessionSurface {
  return readItem(SURFACE_KEY + sessionId) === 'orchestrate' ? 'orchestrate' : 'chat';
}

/** 'chat' is the default, so it is stored as no key: only sessions left on their agents keep one. */
export function writeSurface(sessionId: string, surface: SessionSurface): void {
  if (surface === 'orchestrate') {
    writeItem(SURFACE_KEY + sessionId, surface);
    return;
  }
  try {
    window.localStorage.removeItem(SURFACE_KEY + sessionId);
  } catch {
    // Unwritable storage: readSurface already falls back to 'chat'.
  }
}

export function readView(sessionId: string): OrchestratorViewId {
  const stored = readItem(VIEW_KEY + sessionId);
  return ORCHESTRATOR_VIEWS.find(view => view === stored) ?? 'tavern';
}

export function writeView(sessionId: string, view: OrchestratorViewId): void {
  writeItem(VIEW_KEY + sessionId, view);
}

/**
 * Forgets a deleted session's surface and view. Called from the delete path only: the session list is
 * scoped to the signed-in account while storage is install-wide, so "not listed" never means "gone".
 */
export function forgetSessionPrefs(sessionId: string): void {
  try {
    window.localStorage.removeItem(SURFACE_KEY + sessionId);
    window.localStorage.removeItem(VIEW_KEY + sessionId);
    window.localStorage.removeItem(FINALE_SEEN_KEY + sessionId);
  } catch {
    // A stale preference is harmless; it only applies if the same id ever comes back.
  }
}

export function readDockOpen(): boolean {
  return readItem(DOCK_OPEN_KEY) !== '0';
}

export function writeDockOpen(open: boolean): void {
  writeItem(DOCK_OPEN_KEY, open ? '1' : '0');
}

export function readIntroSeen(): boolean {
  return readItem(INTRO_SEEN_KEY) === '1';
}

export function writeIntroSeen(): void {
  writeItem(INTRO_SEEN_KEY, '1');
}

/** The quest_complete summary whose finale this session last showed; only the latest is kept. */
export function readFinaleSeen(sessionId: string): string | null {
  return readItem(FINALE_SEEN_KEY + sessionId);
}

export function writeFinaleSeen(sessionId: string, run: string): void {
  writeItem(FINALE_SEEN_KEY + sessionId, run);
}
