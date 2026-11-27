import { join } from 'node:path';
import { app, type WebContents } from 'electron';
import type { AttentionOpenEvent } from '@shared/attention';
import { IPC_CHANNELS } from '@shared/ipc';
import type { OrchestrateMiniPayload } from '@shared/orchestrateMini';
import { createFloatingWindowController } from '../floatingWindow';
import { appWindows } from '../windows';
import { registerOrchestrateMiniIpc } from './ipc';
import { OrchestrateMiniPreferencesStore } from './preferences';

export const ORCHESTRATE_MINI_DEFAULT_SIZE = { width: 300, height: 340 } as const;
export const ORCHESTRATE_MINI_MIN_SIZE = { width: 220, height: 96 } as const;

export type OrchestrateMiniDeps = {
  /** Raise the app window on a session's stage (attention's openSession). */
  openSession(open: AttentionOpenEvent): void;
  /** Past the quit confirmation (main/index.ts quitState); a cancelled quit is not quitting. */
  isQuitting(): boolean;
  rendererDevUrl?: string;
};

export type OrchestrateMini = {
  isOpen(): boolean;
  toggle(): void;
  close(): void;
  onOpenChanged(listener: (open: boolean) => void): void;
  /** Loads its preferences and reopens the window if it was open at quit. */
  start(): Promise<void>;
};

/**
 * The always-on-top Orchestrate mini window: the needs-you count and a compact agent list, drawn from the
 * ViewSnapshot an app window's stage publishes (OrchestratorStage via useOrchestrateMini). Main only
 * relays: it keeps the last valid payload, and the window raises the app on a decision but never answers.
 */
export function registerOrchestrateMini(deps: OrchestrateMiniDeps): OrchestrateMini {
  const preferences = new OrchestrateMiniPreferencesStore(join(app.getPath('userData'), 'orchestrate-mini.json'));
  const window = createFloatingWindowController({
    title: 'Orchestrate',
    route: 'orchestrate-mini',
    preload: 'orchestrateMini.js',
    defaultSize: ORCHESTRATE_MINI_DEFAULT_SIZE,
    minSize: ORCHESTRATE_MINI_MIN_SIZE,
    memory: {
      bounds: () => preferences.current().bounds,
      saveBounds: bounds => void preferences.update({ bounds }),
      saveOpen: open => void preferences.update({ open }),
    },
    isQuitting: deps.isQuitting,
    ...(deps.rendererDevUrl ? { rendererDevUrl: deps.rendererDevUrl } : {}),
  });

  // The last stage to publish wins; its payload lapses with its window.
  let latest: { payload: OrchestrateMiniPayload; publisher: WebContents } | null = null;
  const watchedPublishers = new WeakSet<WebContents>();
  const current = (): OrchestrateMiniPayload | null =>
    latest && !latest.publisher.isDestroyed() ? latest.payload : null;
  const push = () => window.send(IPC_CHANNELS.orchestrateMiniSnapshot, current());

  const publish = (payload: OrchestrateMiniPayload | null, publisher: WebContents) => {
    if (payload) latest = { payload, publisher };
    // A stage clearing only clears what it published, not another window's live run.
    else if (!latest || latest.publisher === publisher || latest.publisher.isDestroyed()) latest = null;
    else return;
    if (!watchedPublishers.has(publisher)) {
      watchedPublishers.add(publisher);
      publisher.once('destroyed', () => {
        if (latest?.publisher !== publisher) return;
        latest = null;
        push();
      });
    }
    push();
  };

  window.onVisibilityChanged(open => {
    // The stage publishes only while the window is open, so a payload kept across a close could be from
    // before Presenter mode was turned on; reopening waits for a fresh one instead.
    if (!open) latest = null;
    for (const appWindow of appWindows()) appWindow.webContents.send(IPC_CHANNELS.orchestrateMiniOpen, open);
  });

  registerOrchestrateMiniIpc({
    isAppWindow: sender => appWindows().some(appWindow => appWindow.webContents === sender),
    isMiniWindow: sender => window.owns(sender),
    current,
    publish,
    isOpen: window.isOpen,
    toggle: window.toggle,
    close: window.hide,
    openSession: deps.openSession,
  });

  return {
    isOpen: window.isOpen,
    toggle: window.toggle,
    close: window.hide,
    onOpenChanged: window.onVisibilityChanged,
    start: async () => {
      await preferences.load();
      if (preferences.current().open) window.show();
    },
  };
}
