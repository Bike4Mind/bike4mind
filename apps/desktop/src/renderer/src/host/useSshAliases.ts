import { useEffect, useState } from 'react';
import type { HostEntry, SshAliasEntry } from '@shared/hostConnection';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The aliases of `~/.ssh/config`, read when the set of registered hosts changes (an add or a
 * remove), not on a timer.
 */
export function useSshAliases(entries: readonly HostEntry[]): {
  aliases: SshAliasEntry[] | null;
  error: string | null;
} {
  const [aliases, setAliases] = useState<SshAliasEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = entries
    .filter(entry => entry.kind === 'remote')
    .map(entry => entry.hostId)
    .join('\n');
  useEffect(() => {
    let live = true;
    window.b4m.host
      .sshAliases()
      .then(next => {
        if (!live) return;
        setAliases(next);
        setError(null);
      })
      .catch((failure: unknown) => live && setError(`Could not read your SSH config. ${message(failure)}`));
    return () => {
      live = false;
    };
  }, [key]);
  return { aliases, error };
}

/** The `~/.ssh/config` alias a registered host is reached by; null until read, or for a host with none. */
export function useHostAlias(entry: HostEntry): string | null {
  const { aliases } = useSshAliases([entry]);
  return aliases?.find(candidate => candidate.hostId === entry.hostId)?.alias ?? null;
}
