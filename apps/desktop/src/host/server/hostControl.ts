import type { AuthState } from '@shared/auth';
import type { HostResult } from '@shared/hostProtocol';

export type HostAccount = HostResult<'host/auth/status'>['account'];
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

/** The account a client may compare with its own, or null until the host is signed in. */
export function accountOf(state: AuthState): HostAccount {
  if (state.status !== 'signed-in' || !state.user) return null;
  return { userId: state.user.id, environmentUrl: state.environment.url };
}
