import { z } from 'zod';

/**
 * Zod validation for data crossing the Hearth boundary (API routes, CLI
 * tools, gateways). Must stay in sync with the types in types.ts.
 */

export const actorKindSchema = z.enum(['human', 'agent', 'gateway', 'device', 'system']);

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
