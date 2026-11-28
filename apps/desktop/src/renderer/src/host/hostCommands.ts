import { useSyncExternalStore } from 'react';
import type { HostConnectionsApi } from '@shared/hostConnection';

/** The calls the commands make; `signInApp` signs this Desktop in to Bike4Mind, which hosts need to connect. */
type Source = () => Pick<HostConnectionsApi, 'connect' | 'disconnect' | 'remove'> & { signInApp(): Promise<void> };

export type HostCommands = {
  /** The last failure of a command on this host, until the next command on it. */
  error(hostId: string): string | null;
  subscribe(listener: () => void): () => void;
  connect(hostId: string): Promise<void>;
  disconnect(hostId: string): Promise<void>;
  remove(hostId: string): Promise<void>;
  /** A connected host is disconnected first; any other state goes straight to connect, which skips backoff. */
  reconnect(hostId: string, connected: boolean): Promise<void>;
  signInApp(hostId: string): Promise<void>;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The one place a host is connected, disconnected or reconnected from; failures are kept per host for whoever shows them. */
export function createHostCommands(source: Source): HostCommands {
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const run = async (hostId: string, work: () => Promise<void>) => {
    if (errors.delete(hostId)) notify();
    try {
      await work();
    } catch (error) {
      errors.set(hostId, messageOf(error));
      notify();
    }
  };
  return {
    error: hostId => errors.get(hostId) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: hostId => run(hostId, () => source().connect(hostId)),
    disconnect: hostId => run(hostId, () => source().disconnect(hostId)),
    remove: hostId => run(hostId, () => source().remove(hostId)),
    reconnect: (hostId, connected) =>
      run(hostId, async () => {
        if (connected) await source().disconnect(hostId);
        await source().connect(hostId);
      }),
    signInApp: hostId => run(hostId, () => source().signInApp()),
  };
}

export const hostCommands: HostCommands = createHostCommands(() => ({
  connect: hostId => window.b4m.host.connect(hostId),
  disconnect: hostId => window.b4m.host.disconnect(hostId),
  remove: hostId => window.b4m.host.remove(hostId),
  signInApp: () => window.b4m.auth.signIn(),
}));

export function useHostCommandError(hostId: string, commands: HostCommands = hostCommands): string | null {
  return useSyncExternalStore(
    commands.subscribe,
    () => commands.error(hostId),
    () => commands.error(hostId)
  );
}
