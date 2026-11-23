import { isAxiosError, type AxiosInstance } from 'axios';

/**
 * True for the 403 the server auth middleware returns when MFA is required of this session (enforceMFA
 * or a team policy) and it has no factor enrolled (mfaEnrollmentGate in server/auth/auth.ts).
 */
export const isMfaEnrollmentRequired = (error: unknown): boolean =>
  isAxiosError(error) &&
  error.response?.status === 403 &&
  (error.response.data as { mfaEnrollmentRequired?: unknown } | undefined)?.mfaEnrollmentRequired === true;

/**
 * Calls `onRefusal` on every enrollment-required 403, then rejects as before. Returns the eject
 * function. The server can start refusing before this tab's admin-settings query sees the toggle,
 * so MFAEnforcementWrapper uses this to refetch and render enrollment instead of a broken app.
 */
export function registerMfaEnrollmentInterceptor(client: AxiosInstance, onRefusal: () => void): () => void {
  const id = client.interceptors.response.use(undefined, (error: unknown) => {
    if (isMfaEnrollmentRequired(error)) onRefusal();
    return Promise.reject(error);
  });
  return () => client.interceptors.response.eject(id);
}
