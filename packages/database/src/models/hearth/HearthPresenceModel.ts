import mongoose, { Schema, Model, model, Types } from 'mongoose';
import { CcAgentStatus, type ICcAgentStatus } from '@bike4mind/common';

/**
 * Roster state. This deliberately REUSES the existing code-agent status
 * vocabulary (`CcAgentStatus`) rather than defining a parallel one.
 *
 * That enum already ships in the shared schema and is already the term set the
 * code-agent bridge and its consuming surfaces speak, so inventing a second
 * vocabulary here would mean every consumer translating between two nearly
 * identical sets - and near-identical is worse than different, because
 * `awaiting_input` would silently mean "asked a question" to one surface and
 * "blocked on permission" to another.
 *
 * It is also the finer-grained set, which is the direction that stays open: a
 * consumer that only cares "is this blocked on me" can OR
 * awaiting_permission | awaiting_input, but a coarse vocabulary can never be
 * split back apart after consumers depend on it.
 */
export type HearthPresenceState = ICcAgentStatus;

/**
 * Read order for the roster: most-blocking first. Permission blocks outrank
 * questions because a permission prompt halts execution outright, and they are
 * the dominant blocked state in practice. Exported because the sort runs in the
 * aggregation (see hearthRepository.presenceForChannel) and both places must
 * agree on the ranking.
 */
export const PRESENCE_STATE_RANK: Readonly<Record<HearthPresenceState, number>> = {
  awaiting_permission: 0,
  awaiting_input: 1,
  running: 2,
  idle: 3,
  disconnected: 4,
};

/**
 * SINGLE SOURCE OF TRUTH for reason -> state. `reason` is the closed set the
 * Claude Code hook forwards (packages/cli/bin/hearth-hook.mjs): the documented
 * notification_type values plus the hook's own event-derived codes.
 *
 * Anything unrecognized falls through to 'running', which is the safe default:
 * an unknown reason must never be reported as blocked on the human (that would
 * make the roster cry wolf) nor as idle/disconnected (that would hide a live
 * session).
 */
const REASON_STATES: Readonly<Record<string, HearthPresenceState>> = {
  // A permission prompt halts the session outright - distinct from a question.
  permission_prompt: 'awaiting_permission',
  idle_prompt: 'awaiting_input',
  agent_needs_input: 'awaiting_input',
  elicitation_dialog: 'awaiting_input',
  turn_finished: 'idle',
  agent_completed: 'idle',
  // The session is gone, not merely quiet - the distinction a bare 'idle' loses.
  session_end: 'disconnected',
};

export function presenceStateForReason(reason: string | undefined): HearthPresenceState {
  return (reason && REASON_STATES[reason]) || 'running';
}

/** Shared cap for every projected string field; the writer truncates to it. */
export const MAX_PRESENCE_FIELD_LENGTH = 200;

/**
 * Projection of the presence events in the append-only log: ONE row per
 * (channel, actor), upserted in place rather than appended.
 *
 * Presence is a snapshot of transient state, but the log stores facts forever -
 * so answering "which of my agents is blocked on me right now" from the raw
 * events means scanning every presence event ever written. This collection is
 * the answer to that question in O(actors), and it is also what makes expiring
 * raw presence events safe later: the current state no longer lives only in
 * the event history.
 *
 * The log remains the source of truth. This row is derived and disposable; it
 * can be rebuilt by replaying presence events.
 */
export interface IHearthPresenceDoc {
  _id: Types.ObjectId;
  channelId: Types.ObjectId;
  actorId: Types.ObjectId;
  /** Owning user, denormalized from the channel so the roster reads in one indexed lookup. */
  userId: Types.ObjectId;
  state: HearthPresenceState;
  /** The raw reason code the state was derived from; kept for display and debugging. */
  reason?: string;
  lastSeen: Date;
  /** Projected detail, all optional - a tier-0 hook forwards none of it. */
  workspace?: string;
  tool?: string;
  permissionMode?: string;
  effort?: string;
  sessionId?: string;
  slug?: string;
  subagent?: string;
  backgroundTasks?: number;
  updatedAt: Date;
}

const HearthPresenceSchema = new Schema<IHearthPresenceDoc>(
  {
    channelId: { type: Schema.Types.ObjectId, required: true },
    actorId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    // Derived from the shared enum so a new status cannot be added there and
    // silently rejected here.
    state: { type: String, required: true, enum: CcAgentStatus.options },
    // One cap for every projected string: these are short closed-set codes and
    // names, and the writer truncates to the same number before it gets here.
    reason: { type: String, maxlength: MAX_PRESENCE_FIELD_LENGTH },
    lastSeen: { type: Date, required: true },
    workspace: { type: String, maxlength: MAX_PRESENCE_FIELD_LENGTH },
    tool: { type: String, maxlength: MAX_PRESENCE_FIELD_LENGTH },
    permissionMode: { type: String, maxlength: MAX_PRESENCE_FIELD_LENGTH },
    effort: { type: String, maxlength: MAX_PRESENCE_FIELD_LENGTH },
    sessionId: { type: String, maxlength: MAX_PRESENCE_FIELD_LENGTH },
    slug: { type: String, maxlength: MAX_PRESENCE_FIELD_LENGTH },
    subagent: { type: String, maxlength: MAX_PRESENCE_FIELD_LENGTH },
    backgroundTasks: { type: Number, min: 0 },
  },
  // No createdAt: the row's meaningful timestamp is lastSeen, which is the
  // event's time and not the write's.
  { timestamps: { createdAt: false, updatedAt: true } }
);

// One row per (channel, actor). unique is a data constraint here, not a hint:
// it is what makes the conditional upsert in upsertPresence collapse to a
// no-op for a late event instead of inserting a second row.
HearthPresenceSchema.index({ channelId: 1, actorId: 1 }, { unique: true, name: 'hearth_presence_channel_actor' });
HearthPresenceSchema.index({ userId: 1, channelId: 1 }, { name: 'hearth_presence_user_channel' });

export interface IHearthPresenceModel extends Model<IHearthPresenceDoc> {}

export const HearthPresence: IHearthPresenceModel =
  mongoose.models.HearthPresence ?? model<IHearthPresenceDoc>('HearthPresence', HearthPresenceSchema);

export default HearthPresence;
