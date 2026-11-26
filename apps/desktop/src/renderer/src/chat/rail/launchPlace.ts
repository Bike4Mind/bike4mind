import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NO_LAUNCH_SIGNALS, type LaunchSignals } from '@shared/launchSignals';
import type { LastSession } from '../lastSession';
import { isSessionPlace, type Place, type PlaceMemory, type SessionPlace } from './places';

/**
 * Where the app opens: the place the user last used (the default), or one they pinned.
 *
 * Per-machine UI state beside the place memory it overrides, so localStorage with the same
 * module-store shape as worktreeDefault.ts: the Settings row and the shell read it independently.
 * Only read when the shell mounts, so changing it takes effect on the next launch.
 */
export type LaunchPlace = 'last' | Place;

export const LAUNCH_PLACE_OPTIONS: readonly { value: LaunchPlace; label: string }[] = [
  { value: 'last', label: 'Last used' },
  { value: 'chat', label: 'Chat' },
  { value: 'code', label: 'Code' },
  { value: 'studio', label: 'Studio' },
];

const STORAGE_KEY = 'b4m.chat.launchPlace';

export function parseStoredLaunchPlace(raw: string | null): LaunchPlace {
  return raw === 'chat' || raw === 'code' || raw === 'studio' ? raw : 'last';
}

let current = readStored();
const listeners = new Set<() => void>();

function readStored(): LaunchPlace {
  try {
    return parseStoredLaunchPlace(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage blocked: last used, which is the default anyway.
    return 'last';
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function launchPlace(): LaunchPlace {
  return current;
}

export function setLaunchPlace(next: LaunchPlace): void {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a settings click.
  }
  for (const listener of listeners) listener();
}

/** The setting and its setter; re-renders every reader when either changes it. */
export function useLaunchPlace(): [LaunchPlace, (next: LaunchPlace) => void] {
  return [useSyncExternalStore(subscribe, launchPlace, launchPlace), setLaunchPlace];
}

/** Test seam: re-read storage as a fresh window would. */
export function reloadLaunchPlaceForTest(): void {
  current = readStored();
}

export interface LaunchState {
  place: Place;
  /** The session mode the sidebar lists; Studio keeps one underneath for the trip back. */
  mode: SessionPlace;
  /** The conversation to reopen once the session list loads, if it still exists. */
  session: LastSession | null;
  /** Nothing remembered: the place waits on `pickFirstLaunchPlace` and the machine's signals. */
  firstLaunch: boolean;
}

/**
 * Where the shell opens, from what it remembers and the user's preference.
 *
 * A pinned session place reopens the last session the user had there rather than the last one
 * overall, so pinning Code never lands on a chat. A session that has since gone is the shell's to
 * notice once the list loads (useLastSession), and it then shows the place's most recent session.
 */
export function resolveLaunch(input: {
  preference: LaunchPlace;
  memory: PlaceMemory | null;
  lastSession: LastSession | null;
}): LaunchState {
  const { preference, memory, lastSession } = input;
  const firstLaunch = memory === null && lastSession === null;
  const rememberedPlace = memory?.place ?? lastSession?.mode ?? 'chat';
  const place = preference === 'last' ? rememberedPlace : preference;

  if (isSessionPlace(place)) {
    const remembered = memory?.[place];
    const session = remembered ? { id: remembered, mode: place } : lastSession?.mode === place ? lastSession : null;
    return { place, mode: place, session, firstLaunch: firstLaunch && preference === 'last' };
  }

  const mode = memory && isSessionPlace(memory.place) ? memory.place : (lastSession?.mode ?? 'chat');
  return { place, mode, session: lastSession, firstLaunch: false };
}

/** Code for people who already code on this machine, Chat for everyone else. */
export function pickFirstLaunchPlace(signals: LaunchSignals): SessionPlace {
  return signals.claudeCode || signals.recentRepository ? 'code' : 'chat';
}

/**
 * On a first launch, asks main for the machine's signals and hands the picked place to `onPick`.
 * Returns true until the answer lands, so the shell holds its empty state rather than flashing
 * Chat's first. A failed read counts as no signals: Chat, the same as a non-coder's machine.
 */
export function useFirstLaunchPlace(firstLaunch: boolean, onPick: (place: SessionPlace) => void): boolean {
  const [detecting, setDetecting] = useState(firstLaunch);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!firstLaunch) return;
    let cancelled = false;
    const settle = (signals: LaunchSignals) => {
      if (cancelled) return;
      setDetecting(false);
      pick.current(pickFirstLaunchPlace(signals));
    };
    window.b4m.chat.launchSignals().then(settle, (error: unknown) => {
      console.warn('Could not read launch signals; opening on Chat', error);
      settle(NO_LAUNCH_SIGNALS);
    });
    return () => {
      cancelled = true;
    };
  }, [firstLaunch]);

  return detecting;
}
