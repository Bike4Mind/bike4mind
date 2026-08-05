import { z } from 'zod';
import { presencePayloadSchema, reasonForHookEvent, type HearthEvent } from '@bike4mind/hearth';
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

function clamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, MAX_PRESENCE_FIELD_LENGTH);
}

/**
 * Map a presence event onto the roster row it projects. Returns null when the
 * payload is not a shape we recognize at all, so the caller can skip the write
 * instead of stamping a contentless row.
 *
 * THE ONLY writer of a presence roster row, deliberately: every reporter's live
 * write goes through here, so the live row and a row rebuilt by replaying the
 * log cannot disagree. The bridge used to build its own UpsertPresenceInput
 * instead, which is how it kept a correct live roster while every one of its
 * events replayed to `running`.
 */
export function toPresenceProjection(args: {
  event: HearthEvent;
  userId: string;
  payload: unknown;
}): UpsertPresenceInput | null {
  const parsed = presencePayloadSchema.safeParse(args.payload ?? {});
  if (!parsed.success) return null;
  const { activity } = parsed.data;

  // Fall back to the EVENT NAME when no activity block arrived. The hook attaches
  // `activity` only at disclosure tier 2 but writes `hook_event_name` at every
  // tier, so reading activity.reason alone left `reason` undefined for tiers 0
  // and 1 - and an undefined reason projects to `running`, so a SessionEnd
  // recorded an ended session as permanently live with no later event to correct
  // it. The event name carries no environment disclosure (it is a fixed
  // vocabulary of Claude Code lifecycle names), so using it costs a low-tier
  // session nothing it was trying to withhold.
  const reason = activity?.reason ?? reasonForHookEvent(parsed.data.hook_event_name);

  return {
    channelId: args.event.channelId,
    actorId: args.event.actorId,
    userId: args.userId,
    // The event's own time, so a delayed delivery cannot look more recent than
    // an event that actually happened later.
    lastSeen: args.event.createdAt,
    reason: clamp(reason),
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
