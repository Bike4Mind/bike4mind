import { z } from 'zod';
import type { HearthEvent } from '@bike4mind/hearth';
import {
  hearthRepository,
  MAX_PRESENCE_FIELD_LENGTH,
  type HearthPresenceState,
  type IHearthPresenceDoc,
  type UpsertPresenceInput,
} from '@bike4mind/database';
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

/**
 * Machine payload the roster projects from: the body written by the Claude Code
 * hook (packages/cli/bin/hearth-hook.mjs, schema 'hearth.claude-code-hook@1').
 * Every field is optional and unknown keys are dropped, so a presence event
 * posted by hand - or by a low-disclosure hook tier that forwards no activity -
 * still refreshes lastSeen; it just carries no detail. No length caps here on
 * purpose: an over-long value is truncated rather than rejected, because losing
 * a whole presence update over a long workspace name is the worse failure.
 */
const PresencePayloadSchema = z.object({
  session_id: z.string().nullish(),
  slug: z.string().nullish(),
  workspace: z.string().nullish(),
  activity: z
    .object({
      reason: z.string().nullish(),
      tool: z.string().nullish(),
      permission_mode: z.string().nullish(),
      effort: z.string().nullish(),
      subagent: z.string().nullish(),
      background_tasks: z.number().int().min(0).nullish(),
    })
    .nullish(),
});

function clamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, MAX_PRESENCE_FIELD_LENGTH);
}

/**
 * Map a presence event onto the roster row it projects. Returns null when the
 * payload is not a shape we recognize at all, so the caller can skip the write
 * instead of stamping a contentless row.
 */
export function toPresenceProjection(args: {
  event: HearthEvent;
  userId: string;
  payload: unknown;
}): UpsertPresenceInput | null {
  const parsed = PresencePayloadSchema.safeParse(args.payload ?? {});
  if (!parsed.success) return null;
  const { activity } = parsed.data;

  return {
    channelId: args.event.channelId,
    actorId: args.event.actorId,
    userId: args.userId,
    // The event's own time, so a delayed delivery cannot look more recent than
    // an event that actually happened later.
    lastSeen: args.event.createdAt,
    reason: clamp(activity?.reason),
    workspace: clamp(parsed.data.workspace),
    tool: clamp(activity?.tool),
    permissionMode: clamp(activity?.permission_mode),
    effort: clamp(activity?.effort),
    sessionId: clamp(parsed.data.session_id),
    slug: clamp(parsed.data.slug),
    subagent: clamp(activity?.subagent),
    backgroundTasks: activity?.background_tasks ?? undefined,
  };
}

export interface WireHearthPresence {
  actorId: string;
  actorName?: string;
  state: HearthPresenceState;
  reason?: string;
  lastSeen: string;
  workspace?: string;
  tool?: string;
  permissionMode?: string;
  effort?: string;
  slug?: string;
  subagent?: string;
  backgroundTasks?: number;
}

/** Roster row -> wire shape for GET /api/hearth/presence. */
export function toWireHearthPresence(row: IHearthPresenceDoc, actorName?: string): WireHearthPresence {
  return {
    actorId: row.actorId.toString(),
    actorName,
    state: row.state,
    reason: row.reason,
    lastSeen: row.lastSeen.toISOString(),
    workspace: row.workspace,
    tool: row.tool,
    permissionMode: row.permissionMode,
    effort: row.effort,
    slug: row.slug,
    subagent: row.subagent,
    backgroundTasks: row.backgroundTasks,
  };
}

/** Find-or-create the acting Hearth actor for this request. */
export async function resolveRequestActor(
  user: { id: string; username?: string | null; email?: string | null },
  actor: ActorParam
) {
  return actor
    ? hearthRepository.ensureActor(user.id, actor.kind, actor.displayName)
    : hearthRepository.ensureActor(user.id, 'human', user.username ?? user.email ?? 'user');
}
