/**
 * Node.js-only Instrumentation
 *
 * This file is loaded exclusively in the Node.js runtime (not edge or client).
 * Next.js automatically picks up instrumentation.node.ts for server-only setup.
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
