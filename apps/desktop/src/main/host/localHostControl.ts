import { hostname } from 'node:os';
import type { AuthState } from '@shared/auth';
import { KNOWN_HOST_CAPABILITIES } from '@shared/hostProtocol';
import { loadHostId } from '../../host/headless/hostIdentity';
import { accountOf, type HostControl } from '../../host/server';

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
  return {
    facts: async () => {
      hostId ??= loadHostId(options.dataDirectory).catch((error: unknown) => {
        hostId = null;
        throw error;
      });
      return {
        hostId: await hostId,
        hostName: hostname(),
        hostVersion: options.version,
        capabilities: [...KNOWN_HOST_CAPABILITIES],
        platform: process.platform,
        homeDirectory: options.homeDirectory,
      };
    },
    account: () => accountOf(options.auth.getState()),
    onAccountChanged: listener => options.onAuthStateChanged(state => listener(accountOf(state))),
  };
}
