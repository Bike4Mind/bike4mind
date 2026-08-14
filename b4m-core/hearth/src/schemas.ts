import { z } from 'zod';

/**
 * Zod validation for data crossing the Hearth boundary (API routes, CLI
 * tools, gateways). Must stay in sync with the types in types.ts.
 */

export const actorKindSchema = z.enum(['human', 'agent', 'gateway', 'device', 'system']);

/**
 * The kinds a caller may claim FOR ITSELF. 'human' and 'system' are reserved:
 * the human actor is derived from the authenticated session, never from a
 * request body, so no credential can post an event that renders as the account
 * owner. Claiming one of these three is a downgrade in trust, not a spoof.
 *
 * Single source for both self-identification paths - the actor override and the
 * per-session kind (see HearthActorParamSchema / HearthSessionParamSchema in
 * the client's hearthWire) - so the reserved set cannot drift between them.
 */
export const selfClaimedActorKindSchema = z.enum(['agent', 'gateway', 'device']);
export type SelfClaimedActorKind = z.infer<typeof selfClaimedActorKindSchema>;

export const hearthEventKindSchema = z.enum([
  'message',
  'edit',
  'reaction',
  'artifact',
  'presence',
  'delegation',
  'quest.update',
  'gate.request',
  'gate.resolve',
  'system',
]);

export const hearthHumanBodySchema = z.object({
  text: z.string().min(1),
  format: z.enum(['md', 'text']),
});

export const hearthMachineBodySchema = z.object({
  schema: z.string().min(1),
  payload: z.unknown(),
});

export const hearthEventRefsSchema = z.object({
  threadRootId: z.string().min(1).optional(),
  replyToId: z.string().min(1).optional(),
  questId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
});

export const appendEventInputSchema = z.object({
  channelId: z.string().min(1),
  actorId: z.string().min(1),
  kind: hearthEventKindSchema,
  human: hearthHumanBodySchema,
  machine: hearthMachineBodySchema.optional(),
  refs: hearthEventRefsSchema,
});

export type AppendEventInputParsed = z.infer<typeof appendEventInputSchema>;
