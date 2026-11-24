import { FUNCTION_CONTRACT_LIMITS } from '@bike4mind/common';
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

export const callableFunctionPatchBodySchema = z.object({ enabled: z.boolean() }).strict();

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

// The same 400 `invalid_body` envelope as the connection routes.
export { parseMcpConnectionBody as parseCallableFunctionBody } from './mcpConnectionValidators';
