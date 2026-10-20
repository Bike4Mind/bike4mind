// Cleared with identity caches on logout, expiry, and the next login, and ignored after FIRST_SIGNUP_SESSION_TTL_MS.
export const FIRST_SIGNUP_SESSION_KEY = 'b4m-first-signup-session-user';
export const FIRST_SIGNUP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function markFirstSignupSession(userId: string): void {
  try {
    localStorage.setItem(FIRST_SIGNUP_SESSION_KEY, JSON.stringify({ userId, markedAt: Date.now() }));
  } catch (error) {
    console.warn('Unable to persist first signup session', error);
  }
}

export function isFirstSignupSession(userId: string | undefined, now: number = Date.now()): boolean {
  if (!userId) return false;
  try {
    const raw = localStorage.getItem(FIRST_SIGNUP_SESSION_KEY);
    if (raw === null) return false;
    let parsed: { userId?: unknown; markedAt?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (
      parsed &&
      parsed.userId === userId &&
      typeof parsed.markedAt === 'number' &&
      now - parsed.markedAt < FIRST_SIGNUP_SESSION_TTL_MS
    ) {
      return true;
    }
    localStorage.removeItem(FIRST_SIGNUP_SESSION_KEY);
    return false;
  } catch (error) {
    console.warn('Unable to read first signup session', error);
    return false;
  }
}
