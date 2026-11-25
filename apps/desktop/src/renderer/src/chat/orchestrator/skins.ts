import { useEffect, useSyncExternalStore } from 'react';
import { useTheme } from '@mui/joy/styles';
import type { DesktopApi } from '@shared/ipc';
import type { SkinSummary } from '@shared/mods';
import { readSkin, writeSkin } from './orchestratorPrefs';
import { DEFAULT_SKIN_THEME, mergeSkinTheme, skinCssVariables, type SkinTheme } from './statePalette';

/**
 * The installed skins (validated in main/mods) and the picked one, shared by the picker and every view.
 * A picked skin that is missing or broken leaves the Default theme active; the choice is kept, so the
 * skin comes back once it is fixed.
 */
export interface SkinsState {
  skins: readonly SkinSummary[];
  selectedId: string | null;
  /** The theme in effect: the picked skin's when it validated, else the default. */
  theme: SkinTheme;
  refreshing: boolean;
}

let state: SkinsState = buildState([], readSkin(), false);
let started = false;
const listeners = new Set<() => void>();

function buildState(skins: readonly SkinSummary[], selectedId: string | null, refreshing: boolean): SkinsState {
  const picked = selectedId === null ? undefined : skins.find(skin => skin.id === selectedId);
  return { skins, selectedId, theme: mergeSkinTheme(picked), refreshing };
}

function set(next: SkinsState): void {
  state = next;
  for (const listener of listeners) listener();
}

// Optional at runtime: the mini Tavern window and unit tests have no (or a partial) bridge.
const skinsApi = (): DesktopApi['skins'] | undefined => (window as { b4m?: Partial<DesktopApi> }).b4m?.skins;

/** Lists the skins once and follows main's pushes; a renderer without the bridge (tests) keeps Default. */
function start(): void {
  if (started) return;
  started = true;
  skinsApi()?.onChanged(skins => set(buildState(skins, state.selectedId, state.refreshing)));
  void refreshSkins();
}

export async function refreshSkins(): Promise<void> {
  const api = skinsApi();
  if (!api) return;
  set({ ...state, refreshing: true });
  try {
    set(buildState(await api.list(), state.selectedId, false));
  } catch (error) {
    console.warn(`Could not list skins: ${String(error)}`);
    set({ ...state, refreshing: false });
  }
}

export function selectSkin(id: string | null): void {
  writeSkin(id);
  set(buildState(state.skins, id, state.refreshing));
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): SkinsState => state;

export function useSkins(): SkinsState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useSkinTheme(): SkinTheme {
  return useSkins().theme;
}

/**
 * Puts the active theme's colours on the document root, where the palette helpers (statePalette.ts)
 * read them; on the root rather than the stage so drawers and menus portalled out of it match.
 */
export function useApplySkin(theme: SkinTheme): void {
  const mode = useTheme().palette.mode;
  useEffect(() => {
    if (theme === DEFAULT_SKIN_THEME) return;
    const root = document.documentElement;
    const variables = Object.entries(skinCssVariables(theme, mode));
    for (const [name, value] of variables) root.style.setProperty(name, value);
    return () => {
      for (const [name] of variables) root.style.removeProperty(name);
    };
  }, [theme, mode]);
}

/** Test seam: forget the module state between tests. */
export function resetSkinsForTests(skins: readonly SkinSummary[] = [], selectedId: string | null = null): void {
  started = true;
  state = buildState(skins, selectedId, false);
}
