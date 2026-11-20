import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopApi } from '@shared/ipc';
import type { OrchestrateMiniPayload, OrchestrateMiniSkin } from '@shared/orchestrateMini';
import type { ViewSnapshot } from '@shared/viewSnapshot';
import type { SkinTheme } from './statePalette';

/*
 * The stage's side of the Orchestrate mini window (main/orchestrateMini): whether it is open, and the
 * payload the stage publishes to it while it is. OrchestratorStage builds that payload from the same
 * roster its views draw from, after Presenter mode's redaction, so the mini window never sees more than
 * the stage shows.
 */

type MiniBridge = DesktopApi['orchestrateMini'];

// Optional at runtime: the floating windows and unit tests have no (or a partial) bridge.
const miniBridge = (): MiniBridge | undefined => (window as { b4m?: Partial<DesktopApi> }).b4m?.orchestrateMini;

/** The parts of the active skin the mini window can show; its sprites and sounds stay with the stage. */
export function toMiniSkin(theme: SkinTheme): OrchestrateMiniSkin {
  return {
    id: theme.id,
    states: { ...theme.states },
    surfaces: { ...theme.surfaces },
    ...(theme.fontFamily ? { fontFamily: theme.fontFamily } : {}),
  };
}

/** The mini window never answers, so quick approvals are left behind. */
export function toMiniPayload(snapshot: ViewSnapshot, theme: SkinTheme, presenting: boolean): OrchestrateMiniPayload {
  const { contract, root, agents } = snapshot;
  return { snapshot: { contract, root, agents }, presenting, skin: toMiniSkin(theme) };
}

export interface MiniWindowToggle {
  on: boolean;
  onToggle(on: boolean): void;
}

/** The window's open state, followed from main; undefined where there is no bridge to toggle it with. */
export function useOrchestrateMiniWindow(): MiniWindowToggle | undefined {
  // Read once per mount: the effects below key on the bridge, so a getter that hands back a fresh object
  // each read would resubscribe on every render.
  const [bridge] = useState(miniBridge);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let pulled = false;
    const unsubscribe = bridge.onOpenChanged(next => {
      pulled = true;
      setOpen(next === true);
    });
    // A push that lands first is newer than this pull's answer, which is then dropped.
    bridge
      .isOpen()
      .then(first => {
        if (!pulled) setOpen(first === true);
      })
      .catch((error: unknown) => console.warn(`Could not read the mini window state: ${String(error)}`));
    return unsubscribe;
  }, [bridge]);

  return useMemo(
    () =>
      bridge && {
        on: open,
        onToggle: () => {
          bridge
            .toggle()
            .then(next => setOpen(next === true))
            .catch((error: unknown) => console.warn(`Could not toggle the mini window: ${String(error)}`));
        },
      },
    [bridge, open]
  );
}

/**
 * Keeps main's copy of this stage's payload current while the mini window is open, and withdraws it when
 * the stage goes. Republished only when the payload's content changes, not on every roster re-render.
 */
export function usePublishOrchestrateMini(payload: OrchestrateMiniPayload | null, open: boolean): void {
  const [bridge] = useState(miniBridge);
  const latest = useRef(payload);
  latest.current = payload;
  const key = open ? JSON.stringify(payload) : undefined;

  useEffect(() => {
    if (!bridge || key === undefined) return;
    bridge
      .publish(latest.current)
      .catch((error: unknown) => console.warn(`Could not update the mini window: ${String(error)}`));
  }, [bridge, key]);

  useEffect(() => {
    if (!bridge) return;
    return () => {
      bridge.publish(null).catch((error: unknown) => console.warn(`Could not clear the mini window: ${String(error)}`));
    };
  }, [bridge]);
}
