import { z } from 'zod';

const JSONRPC_VERSION = '2.0' as const;

const hostIdSchema = z.union([z.string(), z.number()]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first five are JSON-RPC's own; the rest are this protocol's, in the server-error range. */
export const HOST_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  protocolMismatch: -32001,
  notSignedIn: -32002,
  snapshotRequired: -32003,
  sessionNotFound: -32004,
  capabilityUnavailable: -32005,
  accountMismatch: -32006,
  pathUnavailable: -32007,
  processNotFound: -32008,
  attachmentRefused: -32009,
} as const;

export const hostErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type HostError = z.infer<typeof hostErrorSchema>;

export const hostRequestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: hostIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type HostRequest = z.infer<typeof hostRequestSchema>;

// A notification is a message with no `id` at all; the pre-check keeps a request whose id is
// malformed from being read as one.
export const hostNotificationSchema = z
  .custom<Record<string, unknown>>(value => isRecord(value) && !('id' in value))
  .pipe(
    z.object({
      jsonrpc: z.literal(JSONRPC_VERSION),
      method: z.string(),
      params: z.unknown().optional(),
    })
  );
export type HostNotification = z.infer<typeof hostNotificationSchema>;

// `result: unknown` is satisfied by a missing key, so presence is checked on the raw input.
export const hostSuccessResponseSchema = z
  .custom<Record<string, unknown>>(value => isRecord(value) && 'result' in value && !('error' in value))
  .pipe(
    z.object({
      jsonrpc: z.literal(JSONRPC_VERSION),
      id: hostIdSchema,
      result: z.unknown(),
    })
  );
export type HostSuccessResponse = z.infer<typeof hostSuccessResponseSchema>;

/** `id` is null when the request it answers could not be parsed far enough to read one. */
export const hostFailureResponseSchema = z
  .custom<Record<string, unknown>>(value => isRecord(value) && !('result' in value))
  .pipe(
    z.object({
      jsonrpc: z.literal(JSONRPC_VERSION),
      id: hostIdSchema.nullable(),
      error: hostErrorSchema,
    })
  );
export type HostFailureResponse = z.infer<typeof hostFailureResponseSchema>;

export const hostResponseSchema = z.union([hostSuccessResponseSchema, hostFailureResponseSchema]);
export type HostResponse = z.infer<typeof hostResponseSchema>;

export const hostMessageSchema = z.union([hostRequestSchema, hostResponseSchema, hostNotificationSchema]);
export type HostMessage = z.infer<typeof hostMessageSchema>;

export type ParsedHostMessage = { ok: true; message: HostMessage } | { ok: false; error: HostError };

/** Never throws: anything that is not a well-formed message comes back as an `invalidRequest` error. */
export function parseHostMessage(raw: unknown): ParsedHostMessage {
  const parsed = hostMessageSchema.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  return {
    ok: false,
    error: { code: HOST_ERROR_CODES.invalidRequest, message: 'Not a valid host message', data: parsed.error.issues },
  };
}

export function hostRequest(id: string | number, method: string, params?: unknown): HostRequest {
  return { jsonrpc: JSONRPC_VERSION, id, method, ...(params === undefined ? {} : { params }) };
}

export function hostResult(id: string | number, result: unknown): HostSuccessResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function hostFailure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): HostFailureResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function hostNotification(method: string, params?: unknown): HostNotification {
  return { jsonrpc: JSONRPC_VERSION, method, ...(params === undefined ? {} : { params }) };
}
