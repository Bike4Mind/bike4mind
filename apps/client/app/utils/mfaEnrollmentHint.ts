import { z } from 'zod';

/**
 * Last MFA status this browser saw for a user, so MFAEnforcementWrapper can render the app
 * straight away on reload for a user it already knows is enrolled, and confirm in the
 * background. It is only a hint: the server enforces enrollment on its own (an unenrolled
 * session gets a 403, see mfaEnrollmentInterceptor), and the gate still blocks as soon as a
 * fresh status says the user is not enrolled.
 *
 * Cleared on identity change via USER_SPECIFIC_LS_KEYS in clearClientCaches.ts.
 */
export const MFA_ENROLLMENT_HINT_KEY = 'mfa-enrollment-hint';

const hintSchema = z.object({ userId: z.string().min(1), enrolled: z.boolean() });

/** True only when the stored hint belongs to this user and says they are enrolled. */
export function readMfaEnrolledHint(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    const raw = localStorage.getItem(MFA_ENROLLMENT_HINT_KEY);
    if (!raw) return false;
    const parsed = hintSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.userId === userId && parsed.data.enrolled;
  } catch {
    // Storage blocked or a corrupt value: no hint just means the normal (blocking) check runs.
    return false;
  }
}

export function writeMfaEnrolledHint(userId: string, enrolled: boolean): void {
  try {
    localStorage.setItem(MFA_ENROLLMENT_HINT_KEY, JSON.stringify({ userId, enrolled }));
  } catch {
    // Storage full or blocked: the only cost is that the next reload waits for the check.
  }
}
