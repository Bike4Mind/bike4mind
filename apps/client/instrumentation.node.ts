/**
 * Node.js-only Instrumentation
 *
 * Imported by instrumentation.ts only when NEXT_RUNTIME is 'nodejs' (not edge or client).
 * Next.js does not load this file by itself.
 *
 * Next's own server already installs log-only uncaughtException/unhandledRejection
 * listeners, so the handlers registered here add structured logging without changing
 * whether the process exits. Next's listener still console.errors every such event, so
 * each one is logged twice and network-class errors still reach error severity.
 */
import { registerProcessErrorHandlers } from '@bike4mind/utils';
import { logExpiringModels, getAvailableModels } from '@bike4mind/llm-adapters';

export function register() {
  registerProcessErrorHandlers(undefined, 'NextServer');

  // Log any models approaching or past their deprecation date. This runs before the DB
  // wires the model catalog, so it sees only the static adapter tables and sunset map.
  getAvailableModels(null)
    .then(models => logExpiringModels(models))
    .catch(() => {
      // Non-fatal: don't block server startup if model catalog is unavailable
    });
}
