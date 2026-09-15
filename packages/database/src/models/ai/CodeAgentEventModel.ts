import { CcAgentStatus, type ICcAgentStatus } from '@bike4mind/common';
import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'CodeAgentEvent';

/**
 * Rolling transcript of events for a Claude Code session (bridge -> server).
 *
 * Populated on every `cc_agent_event` WS message; read by the tavern's
 * `CodeAgentPanel` to show the full scrollback for a given instance.
 *
 * Bounded by a 7-day TTL on `createdAt`. Per-instance growth within that
 * window is bounded indirectly by client-side pagination + the bridge's
 * schema-level 4000-char cap on `text`. If we see runaway growth from a
 * pathological session, add an on-insert count-cap pass here.
 */
export type CodeAgentEventType =
  | 'status'
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'permission_resolved';

export interface ICodeAgentEventDoc {
  _id: string;
  userId: string;
  instanceId: string;
  /** Discriminator - mirrors `ICcAgentEventPayload.type`. */
  type: CodeAgentEventType;
  /** Set when `type === 'status'`. */
  status?: ICcAgentStatus;
  /** Set when `type === 'message'`. */
  role?: 'user' | 'assistant';
  /** Event body (trimmed to schema cap at the WS boundary). For
   *  `permission_request` this holds the input summary. */
  text?: string;
  /** Set for `tool_use` / `tool_result`. */
  tool?: string;
  /** Set for `tool_use` / `tool_result`; lets client match result -> use. */
  toolUseId?: string;
  /** `tool_result.isError` passthrough. */
  isError?: boolean;
  /** Set for `permission_request` / `permission_resolved` - lets the modal
   *  find the matching open prompt when a resolution arrives. */
  requestId?: string;
  /** Set for `permission_request`: the tool/capability being gated. */
  toolName?: string;
  /** Set for `permission_resolved`: user's allow/deny answer. */
  allow?: boolean;
  /** Set for `permission_resolved`: who resolved it. */
  resolvedBy?: 'user' | 'auto';
  /** ISO timestamp the event occurred on the user's machine, as a Date. */
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface ICodeAgentEventModel extends Model<ICodeAgentEventDoc> {}

const CodeAgentEventSchema = new Schema<ICodeAgentEventDoc>(
  {
    userId: { type: String, required: true },
    instanceId: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['status', 'message', 'tool_use', 'tool_result', 'permission_request', 'permission_resolved'],
    },
    status: { type: String, enum: CcAgentStatus.options },
    role: { type: String, enum: ['user', 'assistant'] },
    text: { type: String },
    tool: { type: String },
    toolUseId: { type: String },
    isError: { type: Boolean },
    requestId: { type: String },
    toolName: { type: String },
    allow: { type: Boolean },
    resolvedBy: { type: String, enum: ['user', 'auto'] },
    occurredAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// 7-day TTL - longer than users typically need scrollback, short enough to
// bound unused storage. Lines up with the WorldVision "one sprint" norm.
CodeAgentEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
// Listing: page newest -> oldest for a specific instance owned by a user.
CodeAgentEventSchema.index({ userId: 1, instanceId: 1, createdAt: -1 });

export const CodeAgentEvent: ICodeAgentEventModel =
  (mongoose.models[ModelName] as ICodeAgentEventModel) ||
  model<ICodeAgentEventDoc, ICodeAgentEventModel>(ModelName, CodeAgentEventSchema);

export interface CodeAgentEventInsert {
  userId: string;
  instanceId: string;
  type: CodeAgentEventType;
  status?: ICcAgentStatus;
  role?: 'user' | 'assistant';
  text?: string;
  tool?: string;
  toolUseId?: string;
  isError?: boolean;
  requestId?: string;
  toolName?: string;
  allow?: boolean;
  resolvedBy?: 'user' | 'auto';
  occurredAt: Date;
}

export interface CodeAgentEventListOptions {
  /** Cursor: return events with `createdAt < before`. */
  before?: Date;
  /** Page size (default 50, max 200). */
  limit?: number;
}

export const codeAgentEventRepository = {
  async insert(doc: CodeAgentEventInsert): Promise<void> {
    await CodeAgentEvent.create(doc);
  },

  /**
   * List events for an instance scoped to a user, newest-first. Results are
   * ordered by `createdAt` so the cursor is stable even when the
   * bridge's wall-clock (`occurredAt`) skews relative to the server's.
   */
  async listByInstance(
    userId: string,
    instanceId: string,
    opts: CodeAgentEventListOptions = {}
  ): Promise<ICodeAgentEventDoc[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const filter: Record<string, unknown> = { userId, instanceId };
    if (opts.before) {
      filter.createdAt = { $lt: opts.before };
    }
    return CodeAgentEvent.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  },

  /** Delete all events for an instance - used when a session fully ends. */
  async removeByInstance(userId: string, instanceId: string): Promise<number> {
    const res = await CodeAgentEvent.deleteMany({ userId, instanceId });
    return res.deletedCount ?? 0;
  },
};
