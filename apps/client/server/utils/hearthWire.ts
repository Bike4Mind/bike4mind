import { z } from 'zod';
import type { HearthEvent } from '@bike4mind/hearth';
import { hearthRepository } from '@bike4mind/database';
import { ApiKeyScope, ForbiddenError, type IHearthEventAction } from '@bike4mind/common';

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
 * Agents, gateways, and devices (e.g. the Claude Code hook) self-identify here.
 *
 * 'human' and 'system' are BOTH reserved and rejected: the human actor is
 * derived from the authenticated session in resolveRequestActor, never from
 * the request body. Allowing a caller to claim kind 'human' let any credential
 * post an event that rendered indistinguishably from the account owner - and
 * "who said this" is the entire purpose of an append-only audit log. An actor
 * is always owned by the authenticated user, so this never crossed accounts,
 * but it did forge identity within one.
 */
export const HearthActorParamSchema = z
  .object({
    kind: z.enum(['agent', 'gateway', 'device']).prefault('agent'),
    displayName: z.string().min(1).max(200),
  })
  .optional();

/**
 * Guard for Hearth operations that mutate state: appending events, creating
 * channels, and advancing an actor cursor (consuming events out from under a
 * legitimate agent reader is a mutation, not a read).
 *
 * Session/JWT callers hold full rights over their own data, so scopes do not
 * apply to them. API-key callers must hold hearth:write (or admin:*, which is
 * not treated as a wildcard anywhere else in apiKeyAuth either).
 */
export function assertHearthWriteScope(req: { apiKeyInfo?: { scopes?: string[] } }): void {
  const scopes = req.apiKeyInfo?.scopes;
  if (!scopes) return;
  if (scopes.includes(ApiKeyScope.HEARTH_WRITE) || scopes.includes(ApiKeyScope.ADMIN)) return;
  throw new ForbiddenError('This API key is read-only for Hearth; hearth:write is required');
}

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
