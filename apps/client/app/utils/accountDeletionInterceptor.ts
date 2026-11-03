import { isAxiosError, type AxiosInstance } from 'axios';
import { ACCOUNT_DELETION_PENDING_CODE } from '@bike4mind/common';

/**
 * The scheduled purge date when `error` is the 403 the server returns for an account in its
 * deletion grace period (deletionPendingGate in @bike4mind/server-utils), otherwise null.
 */
export function accountDeletionPendingFrom(error: unknown): string | null {
  if (!isAxiosError(error) || error.response?.status !== 403) return null;
  const data = error.response.data as { code?: unknown; scheduledFor?: unknown } | undefined;
  if (data?.code !== ACCOUNT_DELETION_PENDING_CODE) return null;
  return typeof data.scheduledFor === 'string' ? data.scheduledFor : '';
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
