import { z } from 'zod';
import {
  presencePayloadSchema,
  humanSessionActorName,
  sanitizeSessionLabel,
  reasonForHookEvent,
  type HearthEvent,
} from '@bike4mind/hearth';
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
 * Per-session identity for a HUMAN caller (the B4M CLI). Distinct from
 * HearthActorParamSchema on purpose: that schema lets a machine name ITSELF,
 * which is why 'human' had to be reserved out of it. Here the caller supplies
 * only a session discriminator and the server still derives the name, so the
 * kind stays server-owned and unforgeable.
 *
 * Why this exists at all: actor identity is (userId, kind, displayName), so
 * without a discriminator every CLI session of one user collapsed onto a single
 * actor - and therefore a single per-channel CURSOR. Two CLI agents running
 * hearth_catchup on the same channel consumed each other's events and each saw
 * a partial, non-overlapping slice while believing it was current.
 *
 * `id` is opaque and never rendered raw; `label` is a human-recognizable name
 * for the session (a notebook name) used for display only. Forging either can
 * at most mislabel one of the caller's OWN sessions - the authenticated
 * username is always the prefix - which is why neither needs to be trusted.
 */
export const HearthSessionParamSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
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
type SessionParam = z.infer<typeof HearthSessionParamSchema>;

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

/**
 * Find-or-create the acting Hearth actor for this request.
 *
 * A machine that named itself takes that name. Otherwise the actor is the
 * authenticated human, named from the account - per SESSION when the caller
 * supplied one, so concurrent CLI sessions get independent cursors.
 *
 * The identity key deliberately uses the slug form (no label): see
 * humanSessionActorName for why a renameable string must not reach it.
 * `displayLabel` carries the friendly name separately, so a notebook rename
 * changes what the roster shows without minting a new actor mid-session.
 */
export async function resolveRequestActor(
  user: { id: string; username?: string | null; email?: string | null },
  actor: ActorParam,
  session?: SessionParam
) {
  if (actor) return hearthRepository.ensureActor(user.id, actor.kind, actor.displayName);

  const base = user.username ?? user.email ?? 'user';
  const identity = humanSessionActorName(base, session?.id);
  // Sanitize BEFORE deciding whether to set a label. Keying off the raw label's
  // truthiness would let one that sanitizes away entirely ('()', control chars)
  // still resolve to the slug form and overwrite a friendly label already
  // stored for this session; omitting it leaves that stored value alone.
  const safeLabel = sanitizeSessionLabel(session?.label);
  const displayLabel = safeLabel ? humanSessionActorName(base, session?.id, safeLabel) : undefined;

  // Omit the options argument entirely when there is no label, rather than
  // passing an explicit undefined: ensureActor treats a missing label as "leave
  // whatever is stored alone", and this keeps the common call shape unchanged.
  return displayLabel
    ? hearthRepository.ensureActor(user.id, 'human', identity, { displayLabel })
    : hearthRepository.ensureActor(user.id, 'human', identity);
}
