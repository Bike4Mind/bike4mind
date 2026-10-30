export type OrchestratorViewId = 'tavern' | 'board' | 'table';
export const ORCHESTRATOR_VIEWS: readonly OrchestratorViewId[] = ['tavern', 'board', 'table'];

export type SessionSurface = 'chat' | 'orchestrate';

const SURFACE_KEY = 'b4m.orchestrator.surface.';
const VIEW_KEY = 'b4m.orchestrator.view.';
const DOCK_OPEN_KEY = 'b4m.orchestrator.dockOpen';
const INTRO_SEEN_KEY = 'b4m.orchestrator.introSeen';

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

export function writeSurface(sessionId: string, surface: SessionSurface): void {
  writeItem(SURFACE_KEY + sessionId, surface);
}

export function readView(sessionId: string): OrchestratorViewId {
  const stored = readItem(VIEW_KEY + sessionId);
  return ORCHESTRATOR_VIEWS.find(view => view === stored) ?? 'tavern';
}

export function writeView(sessionId: string, view: OrchestratorViewId): void {
  writeItem(VIEW_KEY + sessionId, view);
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
