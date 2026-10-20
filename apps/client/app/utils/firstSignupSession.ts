// Cleared with identity caches on logout, expiry, and the next login.
export const FIRST_SIGNUP_SESSION_KEY = 'b4m-first-signup-session-user';

export function markFirstSignupSession(userId: string): void {
  try {
    localStorage.setItem(FIRST_SIGNUP_SESSION_KEY, userId);
  } catch (error) {
    console.warn('Unable to persist first signup session', error);
  }
}

export function isFirstSignupSession(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(FIRST_SIGNUP_SESSION_KEY) === userId;
  } catch (error) {
    console.warn('Unable to read first signup session', error);
    return false;
  }
}
