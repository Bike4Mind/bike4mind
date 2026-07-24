/**
 * Zod schemas and TypeScript types for the Hearth CLI integration.
 *
 * These are the WIRE shapes for the /api/hearth/* REST endpoints. They must
 * stay in sync with the domain types in b4m-core/hearth/src/types.ts (the
 * wire uses ISO strings where the domain uses Date, and actorId is assigned
 * server-side from the authenticated session, never sent by the client).
 */
import { z } from 'zod';

export const HearthEventKindSchema = z.enum([
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
export type HearthEventKind = z.infer<typeof HearthEventKindSchema>;

export const HearthHumanBodySchema = z.object({
  text: z.string().min(1),
  format: z.enum(['md', 'text']),
});
export type HearthHumanBody = z.infer<typeof HearthHumanBodySchema>;

export const HearthMachineBodySchema = z.object({
  schema: z.string().min(1),
  payload: z.unknown(),
});
export type HearthMachineBody = z.infer<typeof HearthMachineBodySchema>;

// IDs are .min(1) to match the core boundary schemas (b4m-core/hearth/src/schemas.ts).
export const HearthEventRefsSchema = z.object({
  threadRootId: z.string().min(1).optional(),
  replyToId: z.string().min(1).optional(),
  questId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
});
export type HearthEventRefs = z.infer<typeof HearthEventRefsSchema>;

/** A log event as returned over the wire (createdAt is an ISO string). */
export const HearthEventSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  seq: z.number(),
  actorId: z.string(),
  /** Display name resolved by the server so surfaces need no actor lookup. */
  actorName: z.string().optional(),
  kind: HearthEventKindSchema,
  human: HearthHumanBodySchema,
  machine: HearthMachineBodySchema.optional(),
  refs: HearthEventRefsSchema.prefault({}),
  createdAt: z.string(),
});
export type HearthEvent = z.infer<typeof HearthEventSchema>;

// GET /api/hearth/channels

export const HearthChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  gatewayActorId: z.string().optional(),
  createdAt: z.string().optional(),
});
export type HearthChannel = z.infer<typeof HearthChannelSchema>;

export const ChannelListResponseSchema = z.object({
  channels: z.array(HearthChannelSchema),
});
export type ChannelListResponse = z.infer<typeof ChannelListResponseSchema>;

// POST /api/hearth/events (append; server assigns id/seq/actorId/createdAt)

export const PostEventRequestSchema = z.object({
  channelId: z.string().min(1),
  kind: HearthEventKindSchema,
  human: HearthHumanBodySchema,
  machine: HearthMachineBodySchema.optional(),
  refs: HearthEventRefsSchema.optional(),
});
export type PostEventRequest = z.infer<typeof PostEventRequestSchema>;

export const PostEventResponseSchema = z.object({
  event: HearthEventSchema,
});
export type PostEventResponse = z.infer<typeof PostEventResponseSchema>;

// POST /api/hearth/catchup (cursor read; advance=false peeks without moving it)

export const CatchupRequestSchema = z.object({
  channelId: z.string().min(1),
  advance: z.boolean().optional(),
  limit: z.number().optional(),
});
export type CatchupRequest = z.infer<typeof CatchupRequestSchema>;

export const CatchupResponseSchema = z.object({
  events: z.array(HearthEventSchema),
  /** The actor's cursor after this call (unchanged when advance=false). */
  cursor: z.number(),
});
export type CatchupResponse = z.infer<typeof CatchupResponseSchema>;
