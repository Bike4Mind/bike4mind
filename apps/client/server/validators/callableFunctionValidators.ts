import {
  CALLABLE_FUNCTION_APPROVAL_MODES,
  CALLABLE_FUNCTION_DATA_LIMITS,
  CALLABLE_FUNCTION_EXAMPLE_LIMITS,
  CALLABLE_FUNCTION_GRANT_LIMITS,
  CALLABLE_FUNCTION_SOURCE_MODES,
  CALLABLE_FUNCTION_SOURCE_URL_MAX_CHARS,
  CallableFunctionGrantVisibilitySchema,
  FUNCTION_CONTRACT_LIMITS,
  MCP_TOOL_APPROVAL_MODES,
} from '@bike4mind/common';
import { z } from 'zod';

// Bodies of pages/api/callable-functions/**. `.strict()` everywhere: the hash, the pin, the name, the state, and
// the owner are derived by the server, so a body naming any of them is refused rather than silently ignored.

const pinFields = {
  /** The artifact version the caller saw; a stale one is a 409, and the server pins its own read of the head. */
  expectedVersion: z.number().int().min(1),
  /** Only an object here: `parseFunctionContract` in the registry is the real check. */
  contract: z.record(z.string(), z.unknown()),
};

export const callableFunctionCreateBodySchema = z
  .object({ artifactId: z.string().trim().min(1).max(200), ...pinFields })
  .strict();

export const callableFunctionPinBodySchema = z.object(pinFields).strict();

/** One setting per request: turn the tool on or off, or set when chat asks before a call. */
export const callableFunctionPatchBodySchema = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ approval: z.enum(MCP_TOOL_APPROVAL_MODES) }).strict(),
]);

/** Shape only: the registry checks the name pattern, the owner's access to the file, and the limits. */
export const callableFunctionDataPinBodySchema = z
  .object({ fileId: z.string().trim().min(1).max(200), name: z.string().min(1).max(64) })
  .strict();

/** Shape only: the registry checks names, and each URL's origin. */
export const callableFunctionSourcesBodySchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            url: z.string().min(1).max(CALLABLE_FUNCTION_SOURCE_URL_MAX_CHARS),
            mode: z.enum(CALLABLE_FUNCTION_SOURCE_MODES),
          })
          .strict()
      )
      .max(CALLABLE_FUNCTION_DATA_LIMITS.maxSources),
  })
  .strict();

/**
 * At most the names of the declared tests to run (the ones a budget left not run); the tests themselves and the
 * contract come from the server's own read of the pinned code.
 */
export const callableFunctionTestRunBodySchema = z
  .object({
    tests: z
      .array(z.string().min(1).max(FUNCTION_CONTRACT_LIMITS.maxDescriptionLength))
      .min(1)
      .max(FUNCTION_CONTRACT_LIMITS.maxTests)
      .optional(),
  })
  .strict();

/** Empty: the sequence, runtime, results, label, and state all come from the server's own run. */
export const callableFunctionPromoteBodySchema = z.object({}).strict();

const valueRecord = z.record(z.string(), z.unknown());

/** Shape only: the registry checks each example against the stored contract as it checks declared tests. */
export const callableFunctionExamplesBodySchema = z
  .object({
    examples: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(FUNCTION_CONTRACT_LIMITS.maxDescriptionLength),
            input: valueRecord,
            expected: valueRecord,
            tolerance: z
              .object({ abs: z.number().min(0).optional(), rel: z.number().min(0).optional() })
              .strict()
              .optional(),
            citation: z.string().trim().min(1).max(CALLABLE_FUNCTION_EXAMPLE_LIMITS.maxCitationLength),
          })
          .strict()
      )
      .max(CALLABLE_FUNCTION_EXAMPLE_LIMITS.maxExamples),
  })
  .strict();

/** The whole share, replaced at once; the registry checks the owner belongs to the project or organization named. */
export const callableFunctionGrantsBodySchema = z
  .object({
    visibility: CallableFunctionGrantVisibilitySchema,
    projectId: z.string().trim().min(1).max(64).optional(),
    organizationId: z.string().trim().min(1).max(64).optional(),
    userIds: z.array(z.string().trim().min(1).max(64)).max(CALLABLE_FUNCTION_GRANT_LIMITS.maxUserIds),
  })
  .strict();

/** A recipient's review: the interface hash they were shown, and when to ask before a call. */
export const callableFunctionReviewBodySchema = z
  .object({
    reviewHash: z.string().regex(/^[0-9a-f]{64}$/),
    approval: z.enum(CALLABLE_FUNCTION_APPROVAL_MODES),
  })
  .strict();

/** A reviewed recipient's settings: the approval mode, or turning the function off or on. */
export const callableFunctionReviewSettingsBodySchema = z
  .object({
    approval: z.enum(CALLABLE_FUNCTION_APPROVAL_MODES).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(body => body.approval !== undefined || body.enabled !== undefined, {
    message: 'Name the approval mode or whether the tool is on.',
  });

// The same 400 `invalid_body` envelope as the connection routes.
export { parseMcpConnectionBody as parseCallableFunctionBody } from './mcpConnectionValidators';
