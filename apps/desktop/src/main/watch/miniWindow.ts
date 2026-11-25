import type { WebContents } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { WatchSnapshot } from '@shared/watch';
import { createFloatingWindowController } from '../floatingWindow';
import type { WatchPreferencesStore } from './WatchPreferencesStore';

export const MINI_DEFAULT_SIZE = { width: 420, height: 300 } as const;
export const MINI_MIN_SIZE = { width: 220, height: 56 } as const;

export interface MiniWindowController {
  show(): void;
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Whether an IPC call came from the mini window: its surface answers nobody else. */
  owns(sender: WebContents): boolean;
  push(snapshot: WatchSnapshot): void;
  onVisibilityChanged(listener: (open: boolean) => void): void;
}

export type MiniWindowDeps = {
  preferences: WatchPreferencesStore;
  /** Past the quit confirmation; see FloatingWindowOptions.isQuitting. */
  isQuitting(): boolean;
  rendererDevUrl?: string;
};

/** The always-on-top mini Tavern (floatingWindow.ts), fed the watch snapshot. */
export function createMiniWindowController({
  preferences,
  isQuitting,
  rendererDevUrl,
}: MiniWindowDeps): MiniWindowController {
  const floating = createFloatingWindowController({
    title: 'Mini Tavern',
    route: 'mini-tavern',
    preload: 'mini.js',
    defaultSize: MINI_DEFAULT_SIZE,
    minSize: MINI_MIN_SIZE,
    memory: {
      bounds: () => preferences.current().miniBounds,
      saveBounds: miniBounds => void preferences.update({ miniBounds }),
      saveOpen: miniOpen => void preferences.update({ miniOpen }),
    },
    isQuitting,
    ...(rendererDevUrl ? { rendererDevUrl } : {}),
  });
  return {
    show: floating.show,
    hide: floating.hide,
    toggle: floating.toggle,
    isOpen: floating.isOpen,
    owns: floating.owns,
    push: snapshot => floating.send(IPC_CHANNELS.watchSnapshot, snapshot),
    onVisibilityChanged: floating.onVisibilityChanged,
  };
}
