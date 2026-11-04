import { CanceledError, isAxiosError, type AxiosInstance } from 'axios';
import { ACCOUNT_DELETION_PENDING_CODE } from '@bike4mind/common';
import { isBlockedByPendingDeletion, type DeletionGateUser } from '@bike4mind/server-utils/auth/deletionPendingGate';

/**
 * The scheduled purge date when `error` is the 403 the server returns for an account in its
 * deletion grace period (deletionPendingGate in @bike4mind/server-utils), otherwise null. A 403 with the
 * code but no date is ignored too, so the gate never opens without a date to show.
 */
export function accountDeletionPendingFrom(error: unknown): string | null {
  if (!isAxiosError(error) || error.response?.status !== 403) return null;
  const data = error.response.data as { code?: unknown; scheduledFor?: unknown } | undefined;
  if (data?.code !== ACCOUNT_DELETION_PENDING_CODE) return null;
  return typeof data.scheduledFor === 'string' && data.scheduledFor ? data.scheduledFor : null;
}

/** Calls `onPending` on every deletion-pending 403, then rejects as before. Returns the eject function. */
export function registerAccountDeletionInterceptor(
  client: AxiosInstance,
  onPending: (scheduledFor: string) => void
): () => void {
  const id = client.interceptors.response.use(undefined, (error: unknown) => {
    const scheduledFor = accountDeletionPendingFrom(error);
    if (scheduledFor !== null) onPending(scheduledFor);
    return Promise.reject(error);
  });
  return () => client.interceptors.response.eject(id);
}

let guardUser: DeletionGateUser | null = null;

/** The signed-in user the request guard checks; UserContext keeps it in step with the store. */
export function setDeletionGuardUser(user: DeletionGateUser | null): void {
  guardUser = user;
}

// Not behind the server's deletion gate, and the cancel screen needs a session to act with.
const REFRESH_PATH = '/api/auth/refreshToken';

/**
 * While the signed-in account is deletion-pending, cancels every request the server would refuse
 * before it is sent, so the app's providers and queries cannot flood it with 403s. A cancel
 * rejection skips ApiContext's error logging and 401 handling. Returns the eject function.
 */
export function registerAccountDeletionRequestGuard(client: AxiosInstance): () => void {
  const id = client.interceptors.request.use(config => {
    const url = config.url ?? '';
    const method = (config.method ?? 'get').toUpperCase();
    if (guardUser && url.split('?')[0] !== REFRESH_PATH && isBlockedByPendingDeletion(guardUser, url, method)) {
      throw new CanceledError('Account deletion is pending', config);
    }
    return config;
  });
  return () => client.interceptors.request.eject(id);
}
