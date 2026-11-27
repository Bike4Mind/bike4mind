import { useMemo, useSyncExternalStore } from 'react';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import type { HostConnectionsApi, HostEntry } from '@shared/hostConnection';

/**
 * The hosts this window knows of and where each connection stands, mirrored from main's
 * `host.list` / `host.onStateChanged` (main/host/ConnectionManager). Listening starts with the
 * first subscriber and stops with the last, so a window that never reads hosts asks main nothing.
 */
export type HostRegistry = {
  /** Every registered host, the local one included once main has answered; empty before that. */
  entries(): readonly HostEntry[];
  subscribe(listener: () => void): () => void;
};

const NO_HOSTS: readonly HostEntry[] = [];

export function createHostRegistry(
  source: () => Pick<HostConnectionsApi, 'list' | 'onStateChanged'>,
  reportError: (message: string, detail: unknown) => void = (message, detail) => console.warn(message, detail)
): HostRegistry {
  let current: readonly HostEntry[] = NO_HOSTS;
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  // A push that lands before the first list() answer is newer than it.
  let pushed = false;

  const publish = (hosts: readonly HostEntry[]) => {
    current = hosts;
    for (const listener of listeners) listener();
  };

  const start = () => {
    const api = source();
    pushed = false;
    const off = api.onStateChanged(hosts => {
      pushed = true;
      publish(hosts);
    });
    let live = true;
    api
      .list()
      .then(hosts => {
        if (live && !pushed) publish(hosts);
      })
      .catch((error: unknown) => reportError('Could not list the hosts', error));
    stop = () => {
      live = false;
      off();
    };
  };

  return {
    entries: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stop?.();
        stop = null;
        // The next first subscriber reads main afresh rather than a list from before it listened.
        current = NO_HOSTS;
      };
    },
  };
}

export const hostRegistry: HostRegistry = createHostRegistry(() => window.b4m.host);

/**
 * Whether session requests go to `hostId` now. The local host always serves: its calls go out
 * before main's first host list answers, exactly as they did before hosts were listed. A remote
 * host serves only while `connected`; any other state answers capabilityUnavailable.
 */
export function isServingHost(hostId: string, entries: readonly HostEntry[]): boolean {
  if (hostId === LOCAL_HOST_ID) return true;
  return entries.some(entry => entry.hostId === hostId && entry.state.status === 'connected');
}

/** The local host first, then each connected remote host in main's order. */
export function servingHostIds(entries: readonly HostEntry[]): string[] {
  const remote = entries
    .filter(entry => entry.kind === 'remote' && entry.state.status === 'connected')
    .map(entry => entry.hostId);
  return [LOCAL_HOST_ID, ...remote];
}

/** The capabilities a connected host advertised in `host/info`; empty for one that is not connected. */
export function hostCapabilities(hostId: string, entries: readonly HostEntry[]): readonly string[] {
  const entry = entries.find(candidate => candidate.hostId === hostId);
  return entry?.state.status === 'connected' ? entry.state.info.capabilities : [];
}

export function useHostEntries(registry: HostRegistry = hostRegistry): readonly HostEntry[] {
  return useSyncExternalStore(registry.subscribe, registry.entries, registry.entries);
}

/**
 * servingHostIds as a stable array: the same reference until the set changes, so effects keyed
 * on it run once per host joining or leaving, not on every latency update.
 */
export function useServingHostIds(registry: HostRegistry = hostRegistry): readonly string[] {
  const entries = useHostEntries(registry);
  const key = servingHostIds(entries).join('\n');
  return useMemo(() => key.split('\n'), [key]);
}

/** Remote hosts the user has registered, whatever their state, in main's order. */
export function useRemoteHostIds(registry: HostRegistry = hostRegistry): readonly string[] {
  const entries = useHostEntries(registry);
  const key = entries
    .filter(entry => entry.kind === 'remote')
    .map(entry => entry.hostId)
    .join('\n');
  return useMemo(() => (key ? key.split('\n') : []), [key]);
}
