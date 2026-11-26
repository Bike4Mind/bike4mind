import type { AuthState } from '@shared/auth';
import { KNOWN_HOST_CAPABILITIES } from '@shared/hostProtocol';
import { loadHostId } from '../../host/hostIdentity';
import { accountOf, createHostControl, type HostControl } from '../../host/server';

export type LocalHostControlOptions = {
  auth: { getState(): AuthState };
  onAuthStateChanged(listener: (state: AuthState) => void): () => void;
  dataDirectory: string;
  homeDirectory: string;
  version: string;
};

/**
 * This machine's Desktop as a host. It has every capability the protocol names, and it signs in
 * through its own window, so `host/auth/start` is refused rather than started here.
 */
export function localHostControl(options: LocalHostControlOptions): HostControl {
  let hostId: Promise<string> | null = null;
  return createHostControl({
    hostId: () => {
      hostId ??= loadHostId(options.dataDirectory).catch((error: unknown) => {
        hostId = null;
        throw error;
      });
      return hostId;
    },
    version: options.version,
    homeDirectory: options.homeDirectory,
    capabilities: KNOWN_HOST_CAPABILITIES,
    account: () => accountOf(options.auth.getState()),
    onAuthStateChanged: options.onAuthStateChanged,
  });
}
