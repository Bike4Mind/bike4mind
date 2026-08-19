import { z } from 'zod';
import { registry } from './registry';

/**
 * OpenAPI component registrations for the public surface.
 *
 * Endpoint request/response schemas now live on their contracts (../api-contract)
 * and are registered + `.openapi()`-annotated by registerContract. The only thing
 * left here is the shared error envelope, which registerContract references for
 * the auto-injected 422 (and any endpoint that wants a standard JSON error body).
 */

// --- Reusable JSON error envelope (validation 422s and any JSON error path) ---
export const ErrorResponse = registry.register(
  'ErrorResponse',
  z
    .object({
      error: z.string().openapi({ description: 'Human-readable error message.' }),
      request_id: z.string().optional().openapi({ description: 'Correlation id, mirrors the X-Request-ID header.' }),
    })
    .openapi('ErrorResponse', { example: { error: 'Missing or invalid toolName', request_id: 'abc-123' } })
);
