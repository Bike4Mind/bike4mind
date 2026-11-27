import { useMemo, useSyncExternalStore } from 'react';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import type { HostEntry } from '@shared/hostConnection';
import { hasHostCapability } from '@shared/hostProtocol';
import { hostCapabilities, hostRegistry, type HostRegistry } from './hostRegistry';
import { hostForSession } from './sessionHost';

/**
 * Which session controls can work for a session, by the path their calls take. The one place that
 * decides what renders for a session on another host: a control checks its flag here, never the
 * host itself. Reading, sending, stopping, approving, renaming, archiving and deleting go over the
 * host protocol and are always available, so they have no flag.
 */
export type SessionCapabilities = {
  /**
   * Calls Desktop's own main process serves over IPC (`window.b4m.chat.*`): model and generation
   * settings, regenerate, edit and continue, attachments, file links, side chats, slash commands,
   * pinning, export, held relays, spawn suggestions, background processes, workspace changes,
   * skills and prompt suggestions. They act on the local machine, so they serve local sessions only.
   */
  desktopChat: boolean;
  /** The terminal pane (`window.b4m.terminal`). */
  terminal: boolean;
  /** The browser pane and artifact or link opening in it (`window.b4m.browser`). */
  browser: boolean;
  /** The model picker and local model engine (`window.b4m.models`). */
  models: boolean;
  /** Loops: `/loop`, the loop pill and its stop button. */
  loops: boolean;
  /** The queued-message list and its actions (`queue/*`), offered by a host that advertises `queue`. */
  queue: boolean;
};

const LOCAL_CAPABILITIES: SessionCapabilities = {
  desktopChat: true,
  terminal: true,
  browser: true,
  models: true,
  loops: true,
  queue: true,
};

/**
 * What a session on `session.hostId` (absent: the local host) can offer. The local host offers
 * everything, as it always has. A remote host offers what has a host-protocol path in this client
 * AND that host advertised in `host/info`; the IPC-only controls stay off until the protocol
 * carries them, at which point their flag reads the host's capability list here.
 */
export function sessionCapabilities(
  session: { hostId?: string } | null | undefined,
  hosts: readonly HostEntry[]
): SessionCapabilities {
  const hostId = session?.hostId ?? LOCAL_HOST_ID;
  return capabilitiesOn(hostId, hostCapabilities(hostId, hosts));
}

function capabilitiesOn(hostId: string, advertised: readonly string[]): SessionCapabilities {
  if (hostId === LOCAL_HOST_ID) return LOCAL_CAPABILITIES;
  return {
    desktopChat: false,
    terminal: false,
    browser: false,
    models: false,
    loops: false,
    queue: hasHostCapability(advertised, 'queue'),
  };
}

/**
 * sessionCapabilities for a session on `hostId`, kept current with the registry. It re-renders
 * only when that host's capability list changes, not on every state push (latency, say), so a
 * sidebar row can call it.
 */
export function useHostSessionCapabilities(hostId: string, registry: HostRegistry = hostRegistry): SessionCapabilities {
  // A string snapshot compares by value, which is what keeps the re-renders to real changes.
  const snapshot = () => hostCapabilities(hostId, registry.entries()).join('\n');
  const advertised = useSyncExternalStore(registry.subscribe, snapshot, snapshot);
  return useMemo(() => capabilitiesOn(hostId, advertised ? advertised.split('\n') : []), [hostId, advertised]);
}

/** useHostSessionCapabilities for a session known by id (a listed session or a draft); with none, the local host's. */
export function useSessionCapabilities(sessionId: string | null | undefined): SessionCapabilities {
  return useHostSessionCapabilities(hostForSession(sessionId ?? undefined));
}
