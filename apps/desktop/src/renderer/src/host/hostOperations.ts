import { useSyncExternalStore } from 'react';
import type { HostInstallApi, HostInstallFailure, HostInstallProgress, HostRunningWork } from '@shared/hostConnection';

/**
 * Where one host's install or update stands in this window. The host's connection state stays
 * main's (see hostRegistry); this holds only what the registry cannot: progress between the
 * steps of an install, a refused update waiting for the user's yes, and the last failure.
 */
export type HostOperation =
  | { status: 'idle' }
  | { status: 'running'; kind: 'install' | 'update'; progress: HostInstallProgress | null }
  | { status: 'needsConfirmation'; work: HostRunningWork }
  | { status: 'failed'; kind: 'install' | 'update'; failure: HostInstallFailure };

const IDLE: HostOperation = { status: 'idle' };

export type HostOperations = {
  get(hostId: string): HostOperation;
  subscribe(listener: () => void): () => void;
  /** Records consent in main and installs; progress arrives meanwhile. */
  install(hostId: string): Promise<void>;
  /** Without `force` an update never stops a daemon with work running: it parks in needsConfirmation. */
  update(hostId: string, force: boolean): Promise<void>;
  /** Drops a failure or a pending confirmation. */
  dismiss(hostId: string): void;
};

type Source = () => Pick<HostInstallApi, 'install' | 'update' | 'onInstallProgress'>;

const failureOf = (error: unknown): HostInstallFailure => ({
  kind: 'installFailed',
  detail: error instanceof Error ? error.message : String(error),
  stderrTail: '',
});

export function createHostOperations(source: Source): HostOperations {
  const byHost = new Map<string, HostOperation>();
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;

  const set = (hostId: string, next: HostOperation) => {
    if (next.status === 'idle') byHost.delete(hostId);
    else byHost.set(hostId, next);
    for (const listener of listeners) listener();
  };

  const onProgress = ({ hostId, progress }: { hostId: string; progress: HostInstallProgress }) => {
    const current = byHost.get(hostId);
    if (current?.status === 'running') set(hostId, { ...current, progress });
  };

  const run = async (
    hostId: string,
    kind: 'install' | 'update',
    start: () => ReturnType<HostInstallApi['install']>
  ) => {
    if (byHost.get(hostId)?.status === 'running') return;
    set(hostId, { status: 'running', kind, progress: null });
    try {
      const result = await start();
      if (result.status === 'confirmationRequired') set(hostId, { status: 'needsConfirmation', work: result.work });
      else if (result.status === 'failed') set(hostId, { status: 'failed', kind, failure: result.failure });
      else set(hostId, IDLE);
    } catch (error) {
      set(hostId, { status: 'failed', kind, failure: failureOf(error) });
    }
  };

  return {
    get: hostId => byHost.get(hostId) ?? IDLE,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) stop = source().onInstallProgress(onProgress);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stop?.();
        stop = null;
      };
    },
    install: hostId => run(hostId, 'install', () => source().install(hostId)),
    update: (hostId, force) => run(hostId, 'update', () => source().update(hostId, { force })),
    dismiss(hostId) {
      if (byHost.get(hostId)?.status !== 'running') set(hostId, IDLE);
    },
  };
}

export const hostOperations: HostOperations = createHostOperations(() => window.b4m.host);

export function useHostOperation(hostId: string, operations: HostOperations = hostOperations): HostOperation {
  return useSyncExternalStore(
    operations.subscribe,
    () => operations.get(hostId),
    () => operations.get(hostId)
  );
}
