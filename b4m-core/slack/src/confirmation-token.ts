/**
 * Confirmation token constants and types
 *
 * The confirmation flow uses Quest.pendingAction to store the action to execute.
 * Buttons contain the questId to look up the pendingAction.
 */

// Token expiration time (15 minutes)
export const TOKEN_EXPIRATION_MS = 15 * 60 * 1000;
