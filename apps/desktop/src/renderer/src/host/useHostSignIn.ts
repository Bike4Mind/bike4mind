import { useCallback, useEffect, useState } from 'react';
import { isExternallyOpenable } from '@shared/externalLinks';
import { hostClient, type HostClient } from './HostClient';

/**
 * One host's device-flow sign-in. The host runs the flow; this only asks it to start one, shows
 * the code, and waits. Finishing is main's `host.onStateChanged` leaving `needsSignIn`, which the
 * sheet reads from the registry, so there is no polling here. The one timer is the code's expiry.
 */
export type HostSignInFlow =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'waiting'; verificationUrl: string; userCode: string; expiresAt: number }
  | { status: 'expired' }
  | { status: 'failed'; message: string };

export type HostSignIn = {
  flow: HostSignInFlow;
  /** Asks the host for a fresh code, and opens the verification page in this computer's browser. */
  start: () => void;
};

export function useHostSignIn(
  hostId: string,
  options: { client?: HostClient; now?: () => number; openExternal?: (url: string) => void } = {}
): HostSignIn {
  const {
    client = hostClient,
    now = Date.now,
    openExternal = url => void window.b4m.shell.openExternal(url),
  } = options;
  const [flow, setFlow] = useState<HostSignInFlow>({ status: 'idle' });

  const start = useCallback(() => {
    setFlow({ status: 'starting' });
    client
      .request(hostId, 'host/auth/start')
      .then(grant => {
        if (!isExternallyOpenable(grant.verificationUrl)) {
          setFlow({ status: 'failed', message: 'The host sent a sign-in link this app will not open.' });
          return;
        }
        setFlow({ status: 'waiting', ...grant });
        openExternal(grant.verificationUrl);
      })
      .catch((error: unknown) =>
        setFlow({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      );
  }, [client, hostId, openExternal]);

  const expiresAt = flow.status === 'waiting' ? flow.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setTimeout(() => setFlow({ status: 'expired' }), Math.max(0, expiresAt - now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt, now]);

  return { flow, start };
}
