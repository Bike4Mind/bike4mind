import { useSyncExternalStore } from 'react';
import type { DesktopApi } from '@shared/ipc';
import type { SoundPackEvent, SoundPackSummary } from '@shared/mods';
import { readSoundPack, writeSoundPack } from './orchestratorPrefs';

/**
 * The installed sound packs (validated in main/mods) and the one picked, shared by the picker and the
 * players. One pack is active at a time. A picked pack that is missing or broken plays nothing of its
 * own; the choice is kept, so it comes back once the pack is fixed.
 */
export interface SoundPacksState {
  packs: readonly SoundPackSummary[];
  selectedId: string | null;
  /** The picked pack when it validated, else null. */
  active: Extract<SoundPackSummary, { status: 'ok' }> | null;
  refreshing: boolean;
}

let state: SoundPacksState = buildState([], readSoundPack(), false);
let started = false;
const listeners = new Set<() => void>();

function buildState(
  packs: readonly SoundPackSummary[],
  selectedId: string | null,
  refreshing: boolean
): SoundPacksState {
  const picked = selectedId === null ? undefined : packs.find(pack => pack.id === selectedId);
  return { packs, selectedId, active: picked?.status === 'ok' ? picked : null, refreshing };
}

function set(next: SoundPacksState): void {
  state = next;
  for (const listener of listeners) listener();
}

// Optional at runtime: the mini Tavern window and unit tests have no (or a partial) bridge.
const packsApi = (): DesktopApi['soundPacks'] | undefined => (window as { b4m?: Partial<DesktopApi> }).b4m?.soundPacks;

function start(): void {
  if (started) return;
  started = true;
  packsApi()?.onChanged(packs => set(buildState(packs, state.selectedId, state.refreshing)));
  void refreshSoundPacks();
}

export async function refreshSoundPacks(): Promise<void> {
  const api = packsApi();
  if (!api) return;
  set({ ...state, refreshing: true });
  try {
    set(buildState(await api.list(), state.selectedId, false));
  } catch (error) {
    console.warn(`Could not list sound packs: ${String(error)}`);
    set({ ...state, refreshing: false });
  }
}

export function selectSoundPack(id: string | null): void {
  writeSoundPack(id);
  set(buildState(state.packs, id, state.refreshing));
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const soundPacksState = (): SoundPacksState => state;
const snapshot = soundPacksState;

export function useSoundPacks(): SoundPacksState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const activeSoundPack = (): SoundPacksState['active'] => state.active;

/**
 * The file an event plays, if any. The active pack wins over the active skin; only `finale` can come
 * from a skin, and `needs-you` is never replaceable so it is not an input here at all. No file means
 * the built-in tones (chime.ts).
 */
export function resolveEventSound(
  event: SoundPackEvent,
  sources: { packSounds?: Partial<Record<SoundPackEvent, string>>; skinFinale?: string }
): string | undefined {
  return sources.packSounds?.[event] ?? (event === 'finale' ? sources.skinFinale : undefined);
}

/** Test seam: forget the module state between tests. */
export function resetSoundPacksForTests(
  packs: readonly SoundPackSummary[] = [],
  selectedId: string | null = null,
  hasStarted = true
): void {
  started = hasStarted;
  state = buildState(packs, selectedId, false);
}
