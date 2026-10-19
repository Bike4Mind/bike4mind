/**
 * Node.js-only Instrumentation
 *
 * Imported by instrumentation.ts only when NEXT_RUNTIME is 'nodejs' (not edge or client).
 * Next.js does not load this file by itself.
 *
 * Next's own server already installs log-only uncaughtException/unhandledRejection
 * listeners, so the handlers registered here add structured logging without changing
 * whether the process exits.
 */
import { registerLambdaErrorHandlers } from '@bike4mind/utils';
import { logExpiringModels, getAvailableModels } from '@bike4mind/llm-adapters';

export function register() {
  registerLambdaErrorHandlers();

  // Log any models approaching or past their deprecation date
  getAvailableModels(null)
    .then(models => logExpiringModels(models))
    .catch(() => {
      // Non-fatal: don't block server startup if model catalog is unavailable
    });
}
