import { z } from 'zod';
import { PRESENCE_PAYLOAD_SCHEMA_NAME, presencePayloadSchema } from './presence';

/** `machine.schema` for `delegation` events; the only schema that kind accepts. */
export const DELEGATION_PAYLOAD_SCHEMA_NAME = 'hearth.delegation@1';

/** Extra keys are kept: hearth_delegate spreads caller-supplied extras into the payload. */
export const delegationPayloadSchema = z.looseObject({
  targetActorId: z.string().min(1),
  task: z.string().min(1).max(4000),
});

/**
 * Payload contracts the write route enforces. A schema name not listed here is
 * accepted unvalidated (size-capped only). The legacy presence names
 * ('hearth.claude-code-hook@1', 'hearth.cc-bridge@1') are left out because no
 * current writer emits them (see presence.ts).
 */
export const knownMachinePayloadSchemas: Record<string, z.ZodType> = {
  [DELEGATION_PAYLOAD_SCHEMA_NAME]: delegationPayloadSchema,
  [PRESENCE_PAYLOAD_SCHEMA_NAME]: presencePayloadSchema,
};
