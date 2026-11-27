/**
 * Keys and in-memory resets for per-user state whose owning modules clearClientCaches.ts must not import:
 * many tests mock those modules, and a mock missing an export breaks every importer of clearClientCaches.
 */
export const CHAT_INPUT_DRAFTS_STORAGE_KEY = 'chat-input-drafts';
export const JUPYTER_CONFIG_STORAGE_KEY = 'b4m-jupyter-config';

const resetHooks = new Set<() => void>();

/** Registers in-memory state to drop on identity change, from the module that owns it. */
export function onIdentityReset(hook: () => void): void {
  resetHooks.add(hook);
}

export function runIdentityResetHooks(): void {
  resetHooks.forEach(hook => {
    try {
      hook();
    } catch (error) {
      console.warn('Identity reset hook failed:', error);
    }
  });
}
