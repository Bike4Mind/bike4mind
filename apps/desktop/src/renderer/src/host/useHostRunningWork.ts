import { useEffect, useState } from 'react';
import { busySessions } from '@shared/hostBusy';
import { hostClient } from './HostClient';

export type HostRunningCount = { status: 'loading' } | { status: 'known'; count: number } | { status: 'unknown' };

/**
 * How many of a host's sessions have work running, asked of the host itself rather than counted
 * from the sessions this window happens to have loaded. Asked once each time `enabled` turns on
 * (a panel opening); an unreachable host reads as unknown, never as zero.
 */
export function useHostRunningWork(hostId: string, enabled: boolean): HostRunningCount {
  const [result, setResult] = useState<HostRunningCount>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setResult({ status: 'loading' });
    hostClient
      .request(hostId, 'session/statuses')
      .then(({ statuses }) => live && setResult({ status: 'known', count: busySessions(statuses).length }))
      .catch((error: unknown) => {
        console.warn(`Could not list the running sessions on ${hostId}`, error);
        if (live) setResult({ status: 'unknown' });
      });
    return () => {
      live = false;
    };
  }, [hostId, enabled]);
  return result;
}
