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

/**
 * Doc metadata for the deprecated `name` field. Shared with registerContract, which
 * re-applies it to any error schema that inherits `name` from `ApiErrorSchema` via
 * `.extend()` - those would otherwise publish a bare `name: string` and lose the
 * deprecation everywhere except this component. One source for the wording.
 */
export const DEPRECATED_NAME_METADATA = {
  deprecated: true,
  description:
    'Deprecated, sunset 2026-12-01. The `name` of whatever the server threw - usually one of our ' +
    'own error classes (`NotFoundError`, `UnprocessableEntityError`, ...), but on an unhandled 500 ' +
    'it can be a library or driver class name instead. Unstable by nature: these are internal ' +
    'names we rename at will, and the set is open. Documented only so the wire and this spec ' +
    'agree for the deprecation window; it is removed on the sunset date. Branch on the HTTP ' +
    'status, not on this.',
} as const;

// --- Reusable JSON error envelope (validation 422s and any JSON error path) ---
export const ErrorResponse = registry.register(
  'ErrorResponse',
  z
    .object({
      error: z.string().openapi({ description: 'Human-readable error message.' }),
      request_id: z.string().optional().openapi({ description: 'Correlation id, mirrors the X-Request-ID header.' }),
      name: z.string().optional().openapi(DEPRECATED_NAME_METADATA),
    })
    .openapi('ErrorResponse', { example: { error: 'Missing or invalid toolName', request_id: 'abc-123' } })
);
