import type { AuthState } from '@shared/auth';
import type { HostResult } from '@shared/hostProtocol';

export type HostAccount = HostResult<'host/auth/status'>['account'];

/** The account a client may compare with its own, or null until the host is signed in. */
export function accountOf(state: AuthState): HostAccount {
  if (state.status !== 'signed-in' || !state.user) return null;
  return { userId: state.user.id, environmentUrl: state.environment.url };
}
