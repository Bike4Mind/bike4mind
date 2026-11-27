const ENROLLMENT_ABANDONED_PATH = '/api/auth/mfa/enrollment-abandoned';

/**
 * Tells the server the user left forced MFA enrollment without enrolling (server side:
 * pages/api/auth/mfa/enrollment-abandoned.ts, which decides whether anything is recorded).
 *
 * Takes the token rather than reading it at send time: the callers drop or revoke the credential
 * right after, and the shared api client's interceptor would attach whatever token is current by
 * then. keepalive lets the request outlive the navigation a sign-out starts. Fire-and-forget:
 * telemetry must never hold up or fail leaving.
 */
export function reportMfaEnrollmentAbandoned(accessToken: string | null): void {
  if (!accessToken || typeof fetch !== 'function') return;
  try {
    void fetch(ENROLLMENT_ABANDONED_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: '{}',
    }).catch(() => {
      // Best-effort, as the page beacons.
    });
  } catch {
    // A browser that rejects keepalive may throw synchronously; that must not stop the caller's sign-out.
  }
}
