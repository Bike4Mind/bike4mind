import { z } from 'zod';
import type { HearthEvent } from '@bike4mind/hearth';
import { hearthRepository } from '@bike4mind/database';
import type { IHearthEventAction } from '@bike4mind/common';

type WireHearthEvent = IHearthEventAction['event'];

/**
 * Domain HearthEvent -> wire shape shared by the /api/hearth responses and
 * the hearth_event WS action (Dates become ISO strings; actorName is resolved
 * server-side so surfaces need no actor lookup).
 */
export function toWireHearthEvent(event: HearthEvent, actorName?: string): WireHearthEvent {
  return {
    id: event.id,
    channelId: event.channelId,
    seq: event.seq,
    actorId: event.actorId,
    actorName,
    kind: event.kind,
    human: event.human,
    machine: event.machine,
    refs: event.refs,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * Optional actor identity override shared by the /api/hearth routes.
 * Defaults to the caller's human actor; agents/devices (e.g. the Claude Code
 * hook) self-identify here. Deliberately omits 'system' - callers cannot
 * claim the system actor kind. Always owned by the authenticated user, so
 * this cannot impersonate another user's actors.
 */
export const HearthActorParamSchema = z
  .object({
    kind: z.enum(['human', 'agent', 'gateway', 'device']).prefault('agent'),
    displayName: z.string().min(1).max(200),
  })
  .optional();

type ActorParam = z.infer<typeof HearthActorParamSchema>;

/** Find-or-create the acting Hearth actor for this request. */
export async function resolveRequestActor(
  user: { id: string; username?: string | null; email?: string | null },
  actor: ActorParam
) {
  return actor
    ? hearthRepository.ensureActor(user.id, actor.kind, actor.displayName)
    : hearthRepository.ensureActor(user.id, 'human', user.username ?? user.email ?? 'user');
}
