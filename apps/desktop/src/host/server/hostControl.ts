import { hostname } from 'node:os';
import type { AuthState } from '@shared/auth';
import type { HostCapability, HostResult } from '@shared/hostProtocol';
import { accountOf, type HostAccount } from '../auth/hostAccount';

export { accountOf, type HostAccount };
export type HostSignInStart = HostResult<'host/auth/start'>;

/** What `host/info` reports about the host itself; the server adds the protocol version and the account. */
export type HostFacts = Omit<HostResult<'host/info'>, 'protocol' | 'account'>;

/**
 * The host's identity and sign-in, as the `host/*` methods serve them. Each host shell supplies
 * its own: the headless host signs in by device flow through the protocol, while Desktop signs
 * in through its own window and so leaves `startSignIn` out.
 */
export type HostControl = {
  facts(): Promise<HostFacts>;
  account(): HostAccount;
  /** Resolves once the device code is ready; the outcome arrives as `host/stateChanged`. */
  startSignIn?(): Promise<HostSignInStart>;
  /** Called on every auth state change; the server sends only those that change the account. */
  onAccountChanged(listener: (account: HostAccount) => void): () => void;
};

export type HostControlOptions = {
  /** Resolved on every `host/info`, so a caller may cache it or retry after a failed load. */
  hostId(): Promise<string>;
  version: string;
  homeDirectory: string;
  capabilities: readonly HostCapability[];
  account(): HostAccount;
  /** Subscribes to the host's auth state; returns the unsubscribe. */
  onAuthStateChanged(listener: (state: AuthState) => void): () => void;
  startSignIn?(): Promise<HostSignInStart>;
};

/** The one place the facts and account wiring live, so every host shell reports `host/info` alike. */
export function createHostControl(options: HostControlOptions): HostControl {
  return {
    facts: async () => ({
      hostId: await options.hostId(),
      hostName: hostname(),
      hostVersion: options.version,
      capabilities: [...options.capabilities],
      platform: process.platform,
      homeDirectory: options.homeDirectory,
    }),
    account: options.account,
    ...(options.startSignIn ? { startSignIn: options.startSignIn } : {}),
    onAccountChanged: listener => options.onAuthStateChanged(state => listener(accountOf(state))),
  };
}
