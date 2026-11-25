import { parseStoredLayout, singlePaneLayout, withoutPins, type OrchestratorLayout } from './orchestratorLayout';
import { toViewId, type OrchestratorViewId } from './orchestratorViews';

export { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from './orchestratorViews';

export type SessionSurface = 'chat' | 'orchestrate';

const SURFACE_KEY = 'b4m.orchestrator.surface.';
const VIEW_KEY = 'b4m.orchestrator.view.';
const PROJECT_VIEW_KEY = 'b4m.orchestrator.projectView.';
const LAST_VIEW_KEY = 'b4m.orchestrator.lastView';
const LAYOUT_KEY = 'b4m.orchestrator.layout.';
const PROJECT_LAYOUT_KEY = 'b4m.orchestrator.projectLayout.';
const LAST_LAYOUT_KEY = 'b4m.orchestrator.lastLayout';
const DOCK_OPEN_KEY = 'b4m.orchestrator.dockOpen';
const DOCK_WIDTH_KEY = 'b4m.orchestrator.dockWidth';
const INTRO_SEEN_KEY = 'b4m.orchestrator.introSeen';
const FINALE_SEEN_KEY = 'b4m.orchestrator.finaleSeen.';
const AMBIENT_KEY = 'b4m.orchestrator.ambient';
const AMBIENT_HINT_SEEN_KEY = 'b4m.orchestrator.ambientHintSeen';
const FOCUS_KEY = 'b4m.orchestrator.focus';
const SKIN_KEY = 'b4m.orchestrator.skin';
const SOUND_PACK_KEY = 'b4m.orchestrator.soundPack';
const PRESENTER_KEY = 'b4m.orchestrator.presenter';

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

/**
 * The view a session opens on: its own choice, else the last one picked in its project (the folder
 * the session is bound to; omit for a session without one), else the last one picked anywhere, else
 * the Tavern. A stored id that is no longer a view falls through to the next level.
 */
export function readView(sessionId: string, projectDirectory?: string): OrchestratorViewId {
  return (
    toViewId(readItem(VIEW_KEY + sessionId)) ??
    (projectDirectory ? toViewId(readItem(PROJECT_VIEW_KEY + projectDirectory)) : undefined) ??
    toViewId(readItem(LAST_VIEW_KEY)) ??
    'tavern'
  );
}

/** Records the choice for the session, for its project when it has one, and as the global last choice. */
export function writeView(sessionId: string, view: OrchestratorViewId, projectDirectory?: string): void {
  writeItem(VIEW_KEY + sessionId, view);
  if (projectDirectory) writeItem(PROJECT_VIEW_KEY + projectDirectory, view);
  writeItem(LAST_VIEW_KEY, view);
}

/** One remembered level: its layout, else (a store from before layouts, or a bad layout) its single view. */
function readLayoutLevel(layoutKey: string, viewKey: string): OrchestratorLayout | undefined {
  const layout = parseStoredLayout(readItem(layoutKey));
  if (layout) return layout;
  const view = toViewId(readItem(viewKey));
  return view && singlePaneLayout(view);
}

/**
 * The layout a session opens on, at the same levels as readView: the session's, its project's, the last one
 * anywhere, else the Tavern alone. Each level migrates a stored single view into a single-pane layout.
 */
export function readLayout(sessionId: string, projectDirectory?: string): OrchestratorLayout {
  return (
    readLayoutLevel(LAYOUT_KEY + sessionId, VIEW_KEY + sessionId) ??
    (projectDirectory
      ? readLayoutLevel(PROJECT_LAYOUT_KEY + projectDirectory, PROJECT_VIEW_KEY + projectDirectory)
      : undefined) ??
    readLayoutLevel(LAST_LAYOUT_KEY, LAST_VIEW_KEY) ??
    singlePaneLayout('tavern')
  );
}

/**
 * Records the layout wherever writeView records a view. The first pane's view is written as the single view
 * too, so a level whose layout is later unreadable still opens on it. Session pins are kept at the session
 * level only: at the project and global levels they would name a session unrelated to the next one opened.
 */
export function writeLayout(sessionId: string, layout: OrchestratorLayout, projectDirectory?: string): void {
  writeItem(LAYOUT_KEY + sessionId, JSON.stringify(layout));
  const shared = JSON.stringify(withoutPins(layout));
  if (projectDirectory) writeItem(PROJECT_LAYOUT_KEY + projectDirectory, shared);
  writeItem(LAST_LAYOUT_KEY, shared);
  writeView(sessionId, layout.panes[0].view, projectDirectory);
}

/**
 * Forgets a deleted session's surface and view. Called from the delete path only: the session list is
 * scoped to the signed-in account while storage is install-wide, so "not listed" never means "gone".
 * The project and global last choices are not the session's, so they stay.
 */
export function forgetSessionPrefs(sessionId: string): void {
  try {
    window.localStorage.removeItem(SURFACE_KEY + sessionId);
    window.localStorage.removeItem(VIEW_KEY + sessionId);
    window.localStorage.removeItem(LAYOUT_KEY + sessionId);
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

/** The conversation docked beside the agent stage (px): its default, and the narrowest a drag leaves it. */
export const DOCK_DEFAULT_WIDTH = 380;
export const DOCK_MIN_WIDTH = 300;

/** The dock may take at most half the window, so the stage beside it always keeps the other half. */
export function dockMaxWidth(viewport: number): number {
  return Math.max(0, Math.floor(viewport / 2));
}

/** The maximum wins over the minimum, so a window too small for both still lays out. */
export function clampDockWidth(width: number, max = Number.POSITIVE_INFINITY): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : DOCK_DEFAULT_WIDTH;
  return Math.min(max, Math.max(DOCK_MIN_WIDTH, wanted));
}

/** Clamped only to the minimum: the maximum is the window's, and the window can be bigger next launch. */
export function readDockWidth(): number {
  const stored = readItem(DOCK_WIDTH_KEY);
  return stored === null ? DOCK_DEFAULT_WIDTH : clampDockWidth(Number(stored));
}

export function writeDockWidth(width: number): void {
  writeItem(DOCK_WIDTH_KEY, String(clampDockWidth(width)));
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

/** The Tavern's chrome settling out when idle; on unless turned off. */
export function readAmbient(): boolean {
  return readItem(AMBIENT_KEY) !== '0';
}

export function writeAmbient(on: boolean): void {
  writeItem(AMBIENT_KEY, on ? '1' : '0');
}

export function readAmbientHintSeen(): boolean {
  return readItem(AMBIENT_HINT_SEEN_KEY) === '1';
}

export function writeAmbientHintSeen(): void {
  writeItem(AMBIENT_HINT_SEEN_KEY, '1');
}

/** Focus mode: every view cut down to what needs the user (FocusPanel). Off unless turned on. */
export function readFocus(): boolean {
  return readItem(FOCUS_KEY) === '1';
}

export function writeFocus(on: boolean): void {
  writeItem(FOCUS_KEY, on ? '1' : '0');
}

/** The picked skin's id (main/mods), or null for Default. Install-wide, like the other look-and-feel choices. */
export function readSkin(): string | null {
  return readItem(SKIN_KEY);
}

export function writeSkin(id: string | null): void {
  if (id !== null) {
    writeItem(SKIN_KEY, id);
    return;
  }
  try {
    window.localStorage.removeItem(SKIN_KEY);
  } catch {
    // Unwritable storage: Default for this run only.
  }
}

/** The picked sound pack's id (main/mods), or null for the built-in sounds. */
export function readSoundPack(): string | null {
  return readItem(SOUND_PACK_KEY);
}

export function writeSoundPack(id: string | null): void {
  if (id !== null) {
    writeItem(SOUND_PACK_KEY, id);
    return;
  }
  try {
    window.localStorage.removeItem(SOUND_PACK_KEY);
  } catch {
    // Unwritable storage: the built-in sounds for this run only.
  }
}

/** Presenter mode: the stage redacted for screen sharing (presenter.ts). Off unless turned on. */
export function readPresenter(): boolean {
  return readItem(PRESENTER_KEY) === '1';
}

export function writePresenter(on: boolean): void {
  writeItem(PRESENTER_KEY, on ? '1' : '0');
}
