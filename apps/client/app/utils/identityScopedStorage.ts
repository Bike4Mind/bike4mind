/**
 * Keys and in-memory resets for per-user state whose owning modules clearClientCaches.ts must not import:
 * many tests mock those modules, and a mock missing an export breaks every importer of clearClientCaches.
 */
export const CHAT_INPUT_DRAFTS_STORAGE_KEY = 'chat-input-drafts';
export const JUPYTER_CONFIG_STORAGE_KEY = 'b4m-jupyter-config';

export interface IdentityReset {
  /** The session ended on the server, not by the user: work owned by that user may outlive it. */
  sessionExpired: boolean;
}

const resetHooks = new Set<(reset: IdentityReset) => void>();

/** Registers in-memory state to drop on identity change, from the module that owns it. */
export function onIdentityReset(hook: (reset: IdentityReset) => void): void {
  resetHooks.add(hook);
}

export function runIdentityResetHooks(reset: IdentityReset): void {
  resetHooks.forEach(hook => {
    try {
      hook(reset);
    } catch (error) {
      console.warn('Identity reset hook failed:', error);
    }
  });
}

let signedInUserId: string | null = null;
const signInHooks = new Set<(userId: string) => void>();

/** The last signed-in user id; kept after sign-out so owned state can tell the next user apart. */
export function getSignedInUserId(): string | null {
  return signedInUserId;
}

/** Runs `hook` for every user that signs in, and at once if one already has. */
export function onUserSignedIn(hook: (userId: string) => void): void {
  signInHooks.add(hook);
  if (signedInUserId) hook(signedInUserId);
}

/** Fed by UserContext whenever the current user changes. */
export function setSignedInUserId(userId: string | null | undefined): void {
  if (!userId || userId === signedInUserId) return;
  signedInUserId = userId;
  signInHooks.forEach(hook => {
    try {
      hook(userId);
    } catch (error) {
      console.warn('Sign-in hook failed:', error);
    }
  });
}

/** Test-only: forget the signed-in user. */
export function resetSignedInUserIdForTests(): void {
  signedInUserId = null;
}
