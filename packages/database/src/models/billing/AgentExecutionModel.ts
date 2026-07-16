import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

// --- Status ---
// Canonical tuple lives in `@bike4mind/common` so the wire schema
// (`ChildExecutionSnapshotSchema`) can type `status` as a Zod enum rather than
// `z.string()`. Re-exported here to preserve every existing import path.
import {
  AGENT_EXECUTION_STATUSES,
  ACTIVE_AGENT_EXECUTION_STATUSES,
  type AgentExecutionStatus,
  type GenerateImageToolCall,
} from '@bike4mind/common';
export { AGENT_EXECUTION_STATUSES, ACTIVE_AGENT_EXECUTION_STATUSES, type AgentExecutionStatus };

// --- Iteration Billing ---

export interface IIterationBilling {
  iteration: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  model: string;
  timestamp: Date;
}

// --- Pending Permission ---

export interface IPendingPermission {
  toolName: string;
  toolInput: unknown;
  toolCallId?: string;
  requestedAt: Date;
}

// --- Pending Confidence Gate ---

/**
 * Persisted when a low-confidence iteration trips the confidence gate.
 * Mirrors the role of `pendingPermission`: while it is set, the
 * execution sits in `paused` status until the client responds via the
 * `gate_response` WebSocket command, at which point the continuation Lambda
 * either resumes iteration or marks the run complete with the partial
 * answer. Surfaced on `reconnect_result` so a client returning to a paused
 * execution can re-render the gate UI.
 */
export interface IPendingGate {
  iteration: number;
  confidence: number;
  reason: string;
  requestedAt: Date;
}

// --- Confidence Telemetry ---

/**
 * Per-execution confidence-gate telemetry (issue #56 M1.1). Accumulated across
 * every iteration the gate evaluates so we can measure the gate's real fire
 * rate in production before investing in signal-quality work.
 *
 * Stored as raw accumulators rather than a pre-computed average: `avgConfidence`
 * is derived as `confidenceSum / evaluatedCount` at read time, which is exact
 * and drift-free. Incrementing a stored mean via `$inc` cannot be done
 * correctly, so we never persist one.
 *
 * Counters are advanced with atomic `$inc`/`$min` (see `recordIterationConfidence`
 * / `recordGateEmitted`) so they stay correct across continuation Lambdas, which
 * restart with fresh memory and increment the same persisted document.
 */
export interface IConfidenceTelemetry {
  /** Iterations for which the gate produced a confidence signal and evaluated it. */
  evaluatedCount: number;
  /** Times the gate actually fired and paused the run for human review. */
  emittedCount: number;
  /** Lowest per-iteration confidence observed across the run (1 until first eval). */
  minConfidence: number;
  /** Sum of per-iteration confidences; `avgConfidence = confidenceSum / evaluatedCount`. */
  confidenceSum: number;
}

/**
 * Read-facing confidence-telemetry summary exposed on list items. `avgConfidence`
 * is derived from the stored `confidenceSum`; the raw sum never leaves the model.
 */
export type ConfidenceTelemetrySummary = {
  evaluatedCount: number;
  emittedCount: number;
  minConfidence: number;
  avgConfidence: number;
};

// --- Waiting On Subagent ---

/**
 * Persisted when the parent execution dispatched a child subagent to its own Lambda
 * and ran out of time before the child finished. Captures everything the continuation
 * Lambda needs to surgically replace the placeholder tool result with the actual child
 * answer and resume iteration without breaking the LLM's message coherence (Anthropic
 * rejects consecutive same-role messages, so we replace in place instead of appending).
 */
export interface IWaitingOnChild {
  childExecutionId: string;
  agentName: string;
  toolUse: {
    id: string;
    name: string;
    arguments: string;
  };
  dispatchedAt: Date;
}

// --- DAG Decomposition (web coordinate_task fan-out) ---

/**
 * Persisted shape of a single decomposed task. Structurally compatible with
 * `DecomposeTaskInput['tasks'][number]` in `@bike4mind/agents` but defined
 * inline so this low-level model package doesn't take a dependency on the
 * agents package.
 */
export interface IDagNodeSpec {
  id: string;
  description: string;
  // Keep in sync with `DecomposedTaskSchema.agentType` in
  // `@bike4mind/agents/src/dag/schemas.ts` - this enum is mirrored inline
  // to avoid the database package depending on `@bike4mind/agents`.
  agentType: 'explore' | 'plan' | 'general-purpose' | 'review' | 'test';
  dependsOn: string[];
  onFailure: 'cascade' | 'isolate';
}

/**
 * Persisted on the coordinator/parent execution after the coordinator
 * agent emits a decomposition. The continuation Lambda reads this on
 * resume to rebuild the dependency graph and the markdown report fed
 * back into the parent agent as the `coordinate_task` tool result.
 */
export interface IDagSpec {
  tasks: IDagNodeSpec[];
  /** ID of the coordinate_task tool_use the parent emitted, so the
   *  resume path knows which observation to replace. */
  toolUseId: string;
}

/**
 * Set on the parent when it dispatches DAG children and runs out of time
 * (or the dispatch path naturally hands off). Mirrors `IWaitingOnChild`
 * shape so the resume path can find what it's waiting on without
 * cross-referencing every child every tick.
 */
export interface IWaitingOnDagChildren {
  /** dagNodeId values of children not yet terminal. */
  pendingNodeIds: string[];
  /** tool_use.id from the parent's coordinate_task invocation. */
  toolUseId: string;
  dispatchedAt: Date;
}

// --- Subagent Config (for Lambda-dispatched children) ---

/**
 * Snapshotted onto a child execution doc when its parent dispatched it to a separate
 * Lambda. The dispatched Lambda reads this to resolve the agent definition (via
 * `ServerAgentStore`) and reconstruct the same agent the parent would have spawned
 * in-process. Variables/attachedFiles are propagated verbatim.
 */
export interface ISubagentConfig {
  agentName: string;
  thoroughness: 'quick' | 'medium' | 'very_thorough';
  maxIterations: number;
  variables?: Record<string, string>;
  attachedFiles?: Array<{ fabFileId: string; filename: string; mimeType?: string }>;
}

// --- Main Interface ---

export interface IAgentExecution {
  id: string;
  userId: string;
  organizationId?: string;
  sessionId: string;
  questId: string;
  query: string;
  model: string;

  /**
   * Knowledge / file context forwarded from the client dispatch.
   * Snapshotted at execution-create time so the materialized first-iteration
   * context is stable across Lambda handoffs. Session-level knowledge
   * (`session.knowledgeIds`) is re-read from the live session on each
   * invocation and merged at materialization time.
   */
  messageFileIds?: string[];
  sessionFabFileIds?: string[];

  /**
   * LLM runtime knobs the client selected for this run. Forwarded once at
   * dispatch and persisted so continuation Lambdas reconstruct the same agent.
   */
  temperature?: number;
  maxTokens?: number;
  thinking?: { enabled: boolean; budget_tokens?: number };

  /**
   * The user's selected image-generation config (model, size, quality, etc.),
   * forwarded once at dispatch and persisted so the `image_generation` /
   * `edit_image` tools have a model to run with on every iteration, including
   * continuation Lambdas. Consumed ONLY by
   * `buildSubagentToolConfig` to tool config, never injected into the ReActAgent
   * context, so it stays out of the checkpoint (the prior `structuredClone`
   * failure that motivated removing imageConfig). Absent when the user never
   * selected an image model; the tool then falls back to its built-in default.
   * `Partial` because the client may omit fields, notably `model`, which is
   * required on the base `GenerateImageToolCall` but defaulted by the tool.
   */
  imageConfig?: Partial<GenerateImageToolCall>;

  /**
   * When true, the executor fires `LLMEvents.CompletionCompleted` on terminal
   * `completed` status so the same memento-evaluation handler used by the
   * chat-completion flow runs against the user's prompt. Top-level executions
   * only - subagent / DAG children inherit the parent's run and don't emit
   * their own memento event.
   */
  enableMementos?: boolean;
  /**
   * When true, the executor appends the Lattice tools to the agent's toolbelt
   * (parity with the chat-completion flow's `enableLattice` consumption) so the
   * ReAct loop can offload structured data into a queryable model rather than
   * carrying it in the context window. Persisted at dispatch so it survives
   * Lambda handoffs / continuations (the tool list is rebuilt on every
   * invocation, so the flag must be re-read each time).
   */
  enableLattice?: boolean;
  /** IDs of mementos injected into the first-iteration prompt. Written once at iteration 0;
   * read by persistRunAsQuest so all terminal paths (continuation, gate-stop, abort) get the badge. */
  usedMementoIds?: string[];

  // Execution state
  status: AgentExecutionStatus;
  checkpoint?: unknown; // Serialized AgentCheckpoint from @bike4mind/agents
  result?: unknown; // Final AgentResult on completion
  error?: {
    message: string;
    stack?: string;
    /**
     * Typed signal that the failure was a subagent timeout (deadline watchdog
     * fired, not a generic LLM/network failure). Set explicitly on the timeout
     * write path so consumers don't have to substring-match `message`.
     * Optional for forward compatibility with docs written before this
     * field existed; consumers MUST treat `undefined` as "not known to be a
     * timeout", not "definitely not a timeout".
     */
    timedOut?: boolean;
  };
  /**
   * Coarse classifier for failures that operators / dashboards filter on.
   * `'abandoned'` is set by the scheduled / admin-triggered sweep on stale
   * executions so they can be distinguished from real executor errors.
   * Schema is untyped at the Mongoose level so future variants can be added
   * without a migration; the TS union is the source of truth.
   */
  failureReason?: 'abandoned';

  // Permission state
  approvedTools: string[];
  deniedTools: string[];
  pendingPermission?: IPendingPermission;

  /**
   * Confidence-gate state. Set when iteration confidence drops below
   * the gate threshold; cleared when the client responds via `gate_response`.
   */
  pendingGate?: IPendingGate;

  /**
   * Confidence-gate telemetry (issue #56 M1.1). Accumulated every iteration the
   * gate evaluates; backs the fire-rate metrics surfaced in the admin tab.
   * Optional at the type level because it is a system-managed accumulator no
   * caller sets at create time - the schema default guarantees it at runtime.
   */
  confidenceTelemetry?: IConfidenceTelemetry;

  // Billing
  iterationBilling: IIterationBilling[];
  totalCreditsUsed: number;

  // Lambda handoff
  lambdaInvocationCount: number;

  // Subagent tracking
  parentExecutionId?: string;
  childExecutionIds: string[];

  /**
   * When the parent dispatched this child to a separate Lambda invocation (background or
   * sync timeout-coordination), this captures the agent + runtime knobs the dispatched
   * Lambda needs to resolve the agent definition and spawn the same agent.
   */
  subagentConfig?: ISubagentConfig;

  /**
   * Background children are treated as top-level for cap/billing purposes but keep a
   * link back to the parent that spawned them for audit + abort cascade.
   *
   * `parentExecutionId` is left unset for background children so the existing
   * "exclude children from cap" query naturally counts them. This separate field
   * preserves the lineage.
   */
  isBackgroundExecution?: boolean;
  spawnedByExecutionId?: string;

  /**
   * Set on the parent when it dispatched a synchronous child to its own Lambda and
   * ran out of time mid-poll. The continuation Lambda uses this to inject the child's
   * terminal answer into the parent's tool history.
   */
  waitingOnChild?: IWaitingOnChild;

  /**
   * Separate from `lambdaInvocationCount`. Subagent handoffs (awaiting_subagent ->
   * continuing) shouldn't consume the runaway-iteration budget that
   * `lambdaInvocationCount` protects. Defaults to 0 in the schema; optional in the
   * interface so existing creates that don't set it still typecheck.
   */
  subagentHandoffCount?: number;

  // --- DAG decomposition (coordinate_task) ---

  /** Set on a child execution that represents a node in a coordinator-emitted DAG. */
  dagNodeId?: string;

  /** DAG node ids this node waits on (NOT execution ids - decoupled from execution doc id format). */
  blockedBy?: string[];

  /** Set on the coordinator/parent execution: the full decomposition + the tool_use id of the coordinate_task invocation. */
  dagSpec?: IDagSpec;

  /** Set on the parent when it transitions to `awaiting_dag_children`. */
  waitingOnDagChildren?: IWaitingOnDagChildren;

  // Abort
  abortedAt?: Date;

  // Connection tracking (for WebSocket streaming)
  connectionId?: string;

  // Timing
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// --- Schema ---

const IterationBillingSchema = new mongoose.Schema(
  {
    iteration: { type: Number, required: true },
    inputTokens: { type: Number, required: true },
    outputTokens: { type: Number, required: true },
    cacheReadTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
    credits: { type: Number, required: true },
    model: { type: String, required: true },
    timestamp: { type: Date, required: true },
  },
  { _id: false }
);

const PendingPermissionSchema = new mongoose.Schema(
  {
    toolName: { type: String, required: true },
    toolInput: { type: mongoose.Schema.Types.Mixed },
    toolCallId: { type: String },
    requestedAt: { type: Date, required: true },
  },
  { _id: false }
);

const PendingGateSchema = new mongoose.Schema(
  {
    iteration: { type: Number, required: true },
    confidence: { type: Number, required: true },
    reason: { type: String, required: true },
    requestedAt: { type: Date, required: true },
  },
  { _id: false }
);

// `minConfidence` starts at 1 (the max possible) so the first `$min` update
// with an observed confidence always wins. Do NOT default it to 0, or `$min`
// would latch to 0 forever.
const ConfidenceTelemetrySchema = new mongoose.Schema(
  {
    evaluatedCount: { type: Number, default: 0 },
    emittedCount: { type: Number, default: 0 },
    minConfidence: { type: Number, default: 1 },
    confidenceSum: { type: Number, default: 0 },
  },
  { _id: false }
);

const WaitingOnChildSchema = new mongoose.Schema(
  {
    childExecutionId: { type: String, required: true },
    agentName: { type: String, required: true },
    toolUse: {
      id: { type: String, required: true },
      name: { type: String, required: true },
      arguments: { type: String, required: true },
    },
    dispatchedAt: { type: Date, required: true },
  },
  { _id: false }
);

const DagNodeSpecSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    description: { type: String, required: true },
    agentType: {
      type: String,
      enum: ['explore', 'plan', 'general-purpose', 'review', 'test'],
      required: true,
    },
    dependsOn: { type: [String], default: [] },
    onFailure: {
      type: String,
      enum: ['cascade', 'isolate'],
      default: 'cascade',
    },
  },
  { _id: false }
);

const DagSpecSchema = new mongoose.Schema(
  {
    tasks: { type: [DagNodeSpecSchema], required: true },
    toolUseId: { type: String, required: true },
  },
  { _id: false }
);

const WaitingOnDagChildrenSchema = new mongoose.Schema(
  {
    pendingNodeIds: { type: [String], required: true },
    toolUseId: { type: String, required: true },
    dispatchedAt: { type: Date, required: true },
  },
  { _id: false }
);

const SubagentConfigSchema = new mongoose.Schema(
  {
    agentName: { type: String, required: true },
    thoroughness: { type: String, enum: ['quick', 'medium', 'very_thorough'], required: true },
    maxIterations: { type: Number, required: true },
    variables: { type: mongoose.Schema.Types.Mixed },
    attachedFiles: {
      type: [
        {
          fabFileId: { type: String, required: true },
          filename: { type: String, required: true },
          mimeType: { type: String },
          _id: false,
        },
      ],
      default: undefined,
    },
  },
  { _id: false }
);

const AgentExecutionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    organizationId: { type: String },
    sessionId: { type: String, required: true },
    questId: { type: String, required: true },
    query: { type: String, required: true },
    model: { type: String, required: true },

    // Forwarded knowledge / file context
    messageFileIds: { type: [String], default: undefined },
    sessionFabFileIds: { type: [String], default: undefined },

    // LLM runtime knobs
    temperature: { type: Number },
    maxTokens: { type: Number },
    thinking: {
      type: new mongoose.Schema(
        {
          enabled: { type: Boolean, required: true },
          budget_tokens: { type: Number },
        },
        { _id: false }
      ),
      required: false,
    },

    // User's selected image-generation config. Explicit
    // typed sub-schema (not Mixed) covering every field the image_generation /
    // edit_image tools read, so persistence is auditable and nothing leaks an
    // un-cloneable value. All optional - a config may carry only a model.
    imageConfig: {
      type: new mongoose.Schema(
        {
          model: { type: String },
          editModel: { type: String },
          n: { type: Number },
          quality: { type: String },
          size: { type: String },
          style: { type: String },
          response_format: { type: String },
          width: { type: Number },
          height: { type: Number },
          aspect_ratio: { type: String },
          output_format: { type: String },
          prompt_upsampling: { type: Boolean },
          seed: { type: Number },
          safety_tolerance: { type: Number },
        },
        { _id: false }
      ),
      required: false,
    },

    // Feature-parity flags
    enableMementos: { type: Boolean },
    enableLattice: { type: Boolean },
    usedMementoIds: [{ type: String }],

    // Execution state
    status: {
      type: String,
      enum: AGENT_EXECUTION_STATUSES,
      required: true,
      default: 'pending',
    },
    checkpoint: { type: mongoose.Schema.Types.Mixed },
    result: { type: mongoose.Schema.Types.Mixed },
    error: {
      type: {
        message: { type: String, required: true },
        stack: { type: String },
        timedOut: { type: Boolean },
      },
      required: false,
    },
    failureReason: { type: String },

    // Permission state
    approvedTools: { type: [String], default: [] },
    deniedTools: { type: [String], default: [] },
    pendingPermission: { type: PendingPermissionSchema, required: false },

    // Confidence-gate state
    pendingGate: { type: PendingGateSchema, required: false },

    // Confidence-gate telemetry (#56 M1.1). `default: () => ({})` instantiates
    // the subdoc so its field defaults (evaluatedCount 0, minConfidence 1, ...)
    // apply to every new execution.
    confidenceTelemetry: { type: ConfidenceTelemetrySchema, default: () => ({}) },

    // Billing
    iterationBilling: { type: [IterationBillingSchema], default: [] },
    totalCreditsUsed: { type: Number, default: 0 },

    // Lambda handoff
    lambdaInvocationCount: { type: Number, default: 1 },

    // Subagent tracking
    parentExecutionId: { type: mongoose.Schema.Types.ObjectId },
    childExecutionIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    subagentConfig: { type: SubagentConfigSchema, required: false },
    isBackgroundExecution: { type: Boolean },
    spawnedByExecutionId: { type: mongoose.Schema.Types.ObjectId },
    waitingOnChild: { type: WaitingOnChildSchema, required: false },
    subagentHandoffCount: { type: Number, default: 0 },

    // DAG decomposition (coordinate_task)
    dagNodeId: { type: String },
    blockedBy: { type: [String], default: undefined }, // undefined -> not a DAG child; [] -> root node
    dagSpec: { type: DagSpecSchema, required: false },
    waitingOnDagChildren: { type: WaitingOnDagChildrenSchema, required: false },

    // Abort
    abortedAt: { type: Date },

    // Connection tracking
    connectionId: { type: String },

    // Timing
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// --- Indexes ---

AgentExecutionSchema.index({ userId: 1, createdAt: -1 }); // List user's executions
AgentExecutionSchema.index({ sessionId: 1, status: 1 }); // Find active execution in session
AgentExecutionSchema.index({ questId: 1 }); // Lookup by quest
AgentExecutionSchema.index({ status: 1, createdAt: 1 }); // Find pending/running
AgentExecutionSchema.index({ status: 1, updatedAt: 1 }); // listStuck + findStaleActiveIds (abandoned-sweep)
// Subagent lookup + child-snapshot replay. `findChildExecutions` does
// `.find({ parentExecutionId }).sort({ createdAt: 1 })`; the compound index lets
// MongoDB serve the sort from the index instead of an in-memory sort on every
// reconnect / "Show reasoning" open. The `parentExecutionId` prefix still covers
// plain subagent lookups, so no separate single-field index is needed.
AgentExecutionSchema.index({ parentExecutionId: 1, createdAt: 1 });
// countActiveByUserId - covers both the "no parent" and "background top-level" branches
AgentExecutionSchema.index({ userId: 1, status: 1, parentExecutionId: 1, isBackgroundExecution: 1 });
AgentExecutionSchema.index({ spawnedByExecutionId: 1, status: 1 }); // Abort cascade to background children
AgentExecutionSchema.index({ parentExecutionId: 1, dagNodeId: 1 }); // Sibling lookup during DAG completion handler
AgentExecutionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90-day TTL - preserves billing/audit data

// --- List filters & summary projection (history viewer) ---

export interface ExecutionListFilters {
  statuses?: AgentExecutionStatus[];
  models?: string[];
  minCredits?: number;
  maxCredits?: number;
  fromDate?: Date;
  toDate?: Date;
}

export interface ExecutionListPaging {
  limit: number;
  /** Opaque keyset cursor from the previous page's `nextCursor` - encodes both
   * `createdAt` and `_id` so a same-millisecond boundary doesn't drop rows.
   * Format produced by this repo: `<isoCreatedAt>_<objectId>`. */
  before?: string;
}

/**
 * Lean summary projection used by the execution history list. Excludes the
 * checkpoint, full iteration trace, and per-iteration billing array - those
 * are loaded on demand when a row is expanded.
 */
export interface AgentExecutionListItem {
  id: string;
  userId: string;
  organizationId?: string;
  sessionId: string;
  questId: string;
  query: string;
  model: string;
  status: AgentExecutionStatus;
  totalCreditsUsed: number;
  lambdaInvocationCount: number;
  isBackgroundExecution?: boolean;
  spawnedByExecutionId?: string;
  parentExecutionId?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  abortedAt?: Date;
  totalIterations?: number;
  errorMessage?: string;
  /** Confidence-gate telemetry (#56 M1.1); omitted when the gate never evaluated. */
  confidenceTelemetry?: ConfidenceTelemetrySummary;
}

/**
 * Wire-format variant of {@link AgentExecutionListItem} - `Date` fields become
 * ISO strings after JSON serialization. Client code consumes this type so a
 * future projection change is a type error on both sides instead of silent
 * drift.
 */
export type SerializedAgentExecutionListItem = {
  [K in keyof AgentExecutionListItem]: AgentExecutionListItem[K] extends Date
    ? string
    : AgentExecutionListItem[K] extends Date | undefined
      ? string | undefined
      : AgentExecutionListItem[K];
};

/** Projection shared by every list-style query - keeps wire shape consistent
 *  and avoids loading the large checkpoint / billing fields. */
const EXECUTION_LIST_PROJECTION = {
  userId: 1,
  organizationId: 1,
  sessionId: 1,
  questId: 1,
  query: 1,
  model: 1,
  status: 1,
  totalCreditsUsed: 1,
  lambdaInvocationCount: 1,
  isBackgroundExecution: 1,
  spawnedByExecutionId: 1,
  parentExecutionId: 1,
  startedAt: 1,
  completedAt: 1,
  createdAt: 1,
  updatedAt: 1,
  abortedAt: 1,
  'result.totalIterations': 1,
  'error.message': 1,
  confidenceTelemetry: 1,
} as const;

type ExecutionListLeanDoc = {
  _id: mongoose.Types.ObjectId;
  userId: string;
  organizationId?: string;
  sessionId: string;
  questId: string;
  query: string;
  model: string;
  status: AgentExecutionStatus;
  totalCreditsUsed: number;
  lambdaInvocationCount: number;
  isBackgroundExecution?: boolean;
  spawnedByExecutionId?: mongoose.Types.ObjectId;
  parentExecutionId?: mongoose.Types.ObjectId;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  abortedAt?: Date;
  result?: { totalIterations?: number };
  error?: { message: string };
  confidenceTelemetry?: IConfidenceTelemetry;
};

/**
 * Derive the read-facing telemetry summary. Returns `undefined` when the gate
 * never evaluated (evaluatedCount 0), so the UI can render a clean "no signal"
 * rather than a misleading `min 1.00 / avg NaN`.
 */
function toConfidenceSummary(telemetry: IConfidenceTelemetry | undefined): ConfidenceTelemetrySummary | undefined {
  if (!telemetry || telemetry.evaluatedCount <= 0) return undefined;
  return {
    evaluatedCount: telemetry.evaluatedCount,
    emittedCount: telemetry.emittedCount,
    minConfidence: telemetry.minConfidence,
    avgConfidence: telemetry.confidenceSum / telemetry.evaluatedCount,
  };
}

function toListItem(doc: ExecutionListLeanDoc): AgentExecutionListItem {
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    organizationId: doc.organizationId,
    sessionId: doc.sessionId,
    questId: doc.questId,
    query: doc.query,
    model: doc.model,
    status: doc.status,
    totalCreditsUsed: doc.totalCreditsUsed,
    lambdaInvocationCount: doc.lambdaInvocationCount,
    isBackgroundExecution: doc.isBackgroundExecution,
    spawnedByExecutionId: doc.spawnedByExecutionId?.toString(),
    parentExecutionId: doc.parentExecutionId?.toString(),
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    abortedAt: doc.abortedAt,
    totalIterations: doc.result?.totalIterations,
    errorMessage: doc.error?.message,
    confidenceTelemetry: toConfidenceSummary(doc.confidenceTelemetry),
  };
}

/** Encoded keyset cursor: `<isoCreatedAt>_<objectId>`. */
const CURSOR_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)_([a-f0-9]{24})$/i;

function encodeCursor(createdAt: Date, id: mongoose.Types.ObjectId | string): string {
  return `${createdAt.toISOString()}_${id.toString()}`;
}

export function parseExecutionListCursor(cursor: string): { createdAt: Date; id: string } | null {
  const m = CURSOR_REGEX.exec(cursor);
  if (!m) return null;
  const createdAt = new Date(m[1]);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: m[2] };
}

// --- Repository ---

class AgentExecutionRepository extends BaseRepository<IAgentExecution> {
  constructor(private agentExecutionModel: mongoose.Model<IAgentExecution>) {
    super(agentExecutionModel);
    this.model = agentExecutionModel;
  }

  async findById(id: string): Promise<IAgentExecution | null> {
    const result = await this.model.findById(id);
    return result?.toObject() ?? null;
  }

  async findByQuestId(questId: string): Promise<IAgentExecution | null> {
    const result = await this.model.findOne({ questId });
    return result?.toObject() ?? null;
  }

  async findActiveBySessionId(sessionId: string): Promise<IAgentExecution | null> {
    const result = await this.model.findOne({
      sessionId,
      status: { $in: ACTIVE_AGENT_EXECUTION_STATUSES },
    });
    return result?.toObject() ?? null;
  }

  async findChildExecutions(parentExecutionId: string): Promise<IAgentExecution[]> {
    const results = await this.model.find({ parentExecutionId }).sort({ createdAt: 1 });
    return results.map(doc => doc.toObject());
  }

  /**
   * All executions in a session, projected to just the billing fields, for the
   * per-session usage-detail view. Uses the {sessionId, status} index; oldest
   * first so the trace reads top to bottom.
   */
  async findBillingBySessionId(
    sessionId: string
  ): Promise<
    Array<Pick<IAgentExecution, 'id' | 'status' | 'parentExecutionId' | 'totalCreditsUsed' | 'iterationBilling'>>
  > {
    const results = await this.model
      .find({ sessionId })
      .select('status parentExecutionId totalCreditsUsed iterationBilling')
      .sort({ createdAt: 1 });
    return results.map(doc => doc.toObject());
  }

  /**
   * Find background children spawned by a parent execution. Used by the abort cascade
   * to propagate aborts from the parent to its background children. Returns only
   * children that are still in an active status.
   */
  async findBackgroundChildrenOf(spawnedByExecutionId: string): Promise<IAgentExecution[]> {
    const results = await this.model.find({
      spawnedByExecutionId,
      isBackgroundExecution: true,
      status: { $in: ACTIVE_AGENT_EXECUTION_STATUSES },
    });
    return results.map(doc => doc.toObject());
  }

  /**
   * Count active executions owned by a user. Counts:
   *  - Top-level executions (no `parentExecutionId`)
   *  - Background children (`isBackgroundExecution: true`) - they outlive their parent
   *    and bill independently, so they consume a cap slot.
   *
   * Synchronous in-process subagents (have `parentExecutionId` and no
   * `isBackgroundExecution`) are excluded since they're a transient side effect of an
   * already-counted parent.
   */
  async countActiveByUserId(userId: string): Promise<number> {
    return this.model.countDocuments({
      userId,
      status: { $in: ACTIVE_AGENT_EXECUTION_STATUSES },
      $or: [{ parentExecutionId: { $exists: false } }, { isBackgroundExecution: true }],
    });
  }

  /**
   * Auto-abort the user's stale active executions. Several states can leave
   * an execution counted toward MAX_CONCURRENT_EXECUTIONS_PER_USER without
   * any natural exit path:
   *
   * - `awaiting_permission` - user closed tab / refreshed without responding.
   * - `pending` - SQS handler dropped the message; the executor never picked
   *   it up. Common on local dev when the SST live-lambda tunnel disconnects.
   * - `running` / `continuing` - the executor Lambda crashed or timed out
   *   without writing a terminal status.
   * - `paused` - same as above, plus the rare explicit pause that wasn't
   *   resumed.
   *
   * Without a sweep these accumulate and lock the user out (we saw this
   * happen during demo prep). Mongoose's `updatedAt` is the cleanest
   * staleness signal: a healthy run writes to its doc on every
   * iteration_step / checkpoint / status change, so `updatedAt` slipping
   * past the threshold means the executor is effectively dead.
   *
   * **`awaiting_subagent` is deliberately excluded.** A parent in that state
   * is intentionally idle while a child Lambda runs - and the child's own
   * handoff chain can take hours (the documented worst case is 10 handoffs x
   * 15 min = ~2.5h). The parent's `updatedAt` only ticks on the
   * setWaitingOnChild / clearWaitingOnChild transitions, so a healthy
   * orchestration trivially crosses the 20-minute threshold. Sweeping
   * `awaiting_subagent` here would silently auto-abort live subagent
   * orchestrations, then `clearWaitingOnChild` would no-op when the child
   * finishes (it filters on `abortedAt: { $exists: false }`) - orphaning the
   * trace. Dead-parent detection for `awaiting_subagent` requires
   * cross-referencing the child's terminal status; tracked as a follow-up.
   *
   * Threshold is 20 minutes - generous for typical iteration cadence
   * (~10-30s per step, ~5-15 min for max_thorough runs) but short enough
   * that an abandoned run unblocks the next try within the same session.
   *
   * Returns the number of executions cleaned up so the dispatch handler
   * can log it for diagnostics.
   *
   * Writes `status: 'aborted'` rather than `failed`/`failureReason: 'abandoned'`
   * intentionally: consumers (e.g. `IterationStream.tsx`, child-observation
   * construction in `agentExecutor.ts`) already branch on `aborted` and would
   * see a UX shift if we changed it here. The operator-facing path
   * (`markAbandoned`) is the one that needs explicit classification because
   * an operator inspecting the doc needs to tell a sweep from a real failure.
   */
  async cleanupStaleActive(userId: string, maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const result = await this.model.updateMany(
      {
        userId,
        status: { $in: this.sweepableStatuses },
        updatedAt: { $lt: cutoff },
      },
      {
        $set: {
          status: 'aborted',
          abortedAt: new Date(),
          completedAt: new Date(),
          // Use the existing `error` slot so an operator inspecting the doc
          // can tell this was a sweep, not an explicit user abort.
          error: { message: 'Auto-aborted: stale active execution' },
        },
      }
    );
    return result.modifiedCount ?? 0;
  }

  /** @deprecated Use `cleanupStaleActive` instead - kept as a thin alias
   *  during the transition so any caller landing between commits keeps
   *  working. Remove once nothing references it. */
  async cleanupStaleAwaitingPermission(userId: string, maxAgeMs: number): Promise<number> {
    return this.cleanupStaleActive(userId, maxAgeMs);
  }

  /**
   * Statuses the abandoned-sweep is willing to transition. Both
   * `awaiting_subagent` and `awaiting_dag_children` are excluded because a
   * healthy parent in either state can legitimately idle for hours while
   * children work - the parent's `updatedAt` only ticks on
   * setWaitingOnChild / dispatch / resume transitions, so a healthy
   * orchestration trivially crosses the staleness threshold.
   */
  private get sweepableStatuses(): AgentExecutionStatus[] {
    return ACTIVE_AGENT_EXECUTION_STATUSES.filter(s => s !== 'awaiting_subagent' && s !== 'awaiting_dag_children');
  }

  /**
   * List active-status executions stuck past the given cutoff. Returns just
   * the IDs so the caller can decide what to do (mark abandoned, render to an
   * admin list, etc.) without loading large checkpoint/billing fields.
   */
  async findStaleActiveIds(opts: { userId?: string; olderThan: Date }): Promise<string[]> {
    const query: Record<string, unknown> = {
      status: { $in: this.sweepableStatuses },
      updatedAt: { $lt: opts.olderThan },
    };
    if (opts.userId) query.userId = opts.userId;
    const docs = await this.model.find(query, { _id: 1 }).lean<Array<{ _id: mongoose.Types.ObjectId }>>();
    return docs.map(d => d._id.toString());
  }

  /**
   * Operator-facing read for stuck executions. Returns the summary projection
   * plus the original `updatedAt` so the UI can render how long each row has
   * been wedged. Ordered oldest-first so the most-stuck rows surface first.
   */
  async listStuck(opts: {
    olderThan: Date;
    statuses?: AgentExecutionStatus[];
    userId?: string;
    limit: number;
  }): Promise<AgentExecutionListItem[]> {
    const statuses = opts.statuses?.length ? opts.statuses : this.sweepableStatuses;
    const query: Record<string, unknown> = {
      status: { $in: statuses },
      updatedAt: { $lt: opts.olderThan },
    };
    if (opts.userId) query.userId = opts.userId;
    const docs = await this.model
      .find(query, EXECUTION_LIST_PROJECTION)
      .sort({ updatedAt: 1 })
      .limit(opts.limit)
      .lean<ExecutionListLeanDoc[]>();
    return docs.map(toListItem);
  }

  /**
   * Transition the given executions to `failed` + `failureReason: 'abandoned'`.
   * Only executions still in a sweepable active status are flipped, so a
   * concurrent natural completion / explicit abort wins the race and we
   * don't clobber its terminal state.
   *
   * Uses per-doc `findOneAndUpdate` (status-guarded) so the returned array
   * reflects only the docs we actually wrote to - callers can safely emit a
   * `failed` WS event for every entry without risking a contradictory frame
   * for an execution that just naturally completed between read and write.
   *
   * Chunked to bound `findOneAndUpdate` concurrency - a bug that produces
   * thousands of stale docs would otherwise hammer the connection pool on the
   * first sweep.
   */
  async markAbandoned(ids: string[]): Promise<Array<{ id: string; userId: string }>> {
    if (ids.length === 0) return [];
    const CHUNK_SIZE = 200;
    const now = new Date();
    const projection = { _id: 1, userId: 1 } as const;
    const results: Array<{ id: string; userId: string }> = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const updates = await Promise.all(
        chunk.map(id =>
          this.model
            .findOneAndUpdate(
              { _id: new mongoose.Types.ObjectId(id), status: { $in: this.sweepableStatuses } },
              {
                $set: {
                  status: 'failed',
                  failureReason: 'abandoned',
                  completedAt: now,
                  error: { message: 'Abandoned: stale active execution' },
                },
              },
              { projection, new: true, lean: true }
            )
            .lean<{ _id: mongoose.Types.ObjectId; userId: string } | null>()
        )
      );
      for (const doc of updates) {
        if (doc) results.push({ id: doc._id.toString(), userId: doc.userId });
      }
    }
    return results;
  }

  async updateStatus(id: string, status: AgentExecutionStatus): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (status === 'completed') {
      update.completedAt = new Date();
    }
    // `startedAt` is set exclusively by `claimExecution` on the initial pending -> running
    // transition, so handoffs (running <-> continuing) preserve the original timestamp.
    await this.model.updateOne({ _id: id }, { $set: update });
  }

  /**
   * Atomic compare-and-swap status transition.
   * Returns true if the update matched (this Lambda won the race).
   * Returns false if another Lambda already transitioned the status.
   *
   * `startedAt` is only set when transitioning out of `pending` so duration
   * calculations remain accurate across continuation handoffs.
   */
  async claimExecution(
    id: string,
    fromStatuses: AgentExecutionStatus[],
    toStatus: AgentExecutionStatus
  ): Promise<boolean> {
    const setOps: Record<string, unknown> = { status: toStatus };
    if (fromStatuses.includes('pending')) {
      setOps.startedAt = new Date();
    }
    const result = await this.model.updateOne({ _id: id, status: { $in: fromStatuses } }, { $set: setOps });
    return result.modifiedCount > 0;
  }

  async updateCheckpoint(id: string, checkpoint: unknown): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { checkpoint } });
  }

  /**
   * Persist in-flight steps without disturbing other checkpoint fields.
   *
   * Used by `agentExecutor`'s per-emit step-stream listener so a mid-iteration
   * refresh can replay the in-flight Thought/Action/Observation trace via
   * `handleReconnect`. Without this, `checkpoint.steps` is only written when
   * `runIteration()` returns - for long tool calls (notably `delegate_to_agent`
   * to an in-process subagent), a hard refresh in that window leaves the
   * persisted `checkpoint.steps` empty and the post-refresh UI stuck on the
   * rotating placeholder until the next iteration boundary lands.
   *
   * Uses dot-path `$set` to avoid re-serializing the much larger `messages`
   * array on every emit, which is what `updateCheckpoint(toCheckpoint())`
   * would do. Iteration-boundary `updateCheckpoint` writes remain the source
   * of truth for Lambda continuation; this method only touches
   * `checkpoint.steps`.
   */
  async updateInflightSteps(id: string, steps: unknown[]): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { 'checkpoint.steps': steps } });
  }

  /**
   * Persist a checkpoint and transition status in a single atomic write.
   * Used by the timeout handoff path so a Lambda kill cannot leave the
   * document with an updated checkpoint but stale `running` status (which
   * would orphan the execution by failing the continuation Lambda's CAS).
   */
  async updateCheckpointAndStatus(id: string, checkpoint: unknown, status: AgentExecutionStatus): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { checkpoint, status } });
  }

  async updateConnectionId(id: string, connectionId: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { connectionId } });
  }

  async persistMementoIds(id: string, mementoIds: string[]): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { usedMementoIds: mementoIds } });
  }

  async updatePermissionState(
    id: string,
    update: {
      pendingPermission?: IPendingPermission | null;
      approvedTool?: string;
      deniedTool?: string;
    }
  ): Promise<void> {
    const setOps: Record<string, unknown> = {};
    const pushOps: Record<string, unknown> = {};
    const unsetOps: Record<string, unknown> = {};

    if (update.pendingPermission === null) {
      unsetOps.pendingPermission = '';
    } else if (update.pendingPermission) {
      setOps.pendingPermission = update.pendingPermission;
    }

    if (update.approvedTool) {
      pushOps.approvedTools = update.approvedTool;
    }
    if (update.deniedTool) {
      pushOps.deniedTools = update.deniedTool;
    }

    const ops: Record<string, unknown> = {};
    if (Object.keys(setOps).length > 0) ops.$set = setOps;
    if (Object.keys(pushOps).length > 0) ops.$addToSet = pushOps;
    if (Object.keys(unsetOps).length > 0) ops.$unset = unsetOps;

    if (Object.keys(ops).length > 0) {
      await this.model.updateOne({ _id: id }, ops);
    }
  }

  /**
   * Atomic "pause for confidence gate" transition. Persists the gate
   * context and transitions status to `paused` in a single update so a Lambda
   * kill between the two writes cannot leave the doc in an inconsistent state
   * (status `paused` with no `pendingGate`, or `pendingGate` set without
   * `paused`).
   *
   * Filtered on `abortedAt` non-existence - mirrors `clearWaitingOnChild` /
   * `clearPendingGate`. Race window: the executor's abort-flag check at the
   * top of the iteration loop can miss a `handleAbort` that lands between the
   * check and this call. Without the filter, we would write `status: 'paused'`
   * over a doc that's already logically aborted. Caller checks the return and
   * bails when `false`.
   */
  async setPendingGate(id: string, pendingGate: IPendingGate): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, abortedAt: { $exists: false } },
      { $set: { pendingGate, status: 'paused' } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Clear the gate marker. Caller is responsible for any subsequent status
   * transition (continuing -> re-invoke Lambda, completed -> markComplete).
   * Mirrors the `clearWaitingOnChild` `abortedAt`-not-exists guard so a
   * concurrent abort doesn't get resurrected.
   */
  async clearPendingGate(id: string): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, abortedAt: { $exists: false } },
      { $unset: { pendingGate: '' } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Record one gate-evaluated iteration's confidence (#56 M1.1). Atomic
   * `$inc`/`$min` so the counters stay correct across continuation Lambdas,
   * which restart with fresh memory and increment the same persisted doc.
   * Called for every iteration the gate evaluates - including ones that
   * complete in the same turn or clear the threshold - so `evaluatedCount` is
   * the honest denominator for the gate's fire rate.
   */
  async recordIterationConfidence(id: string, confidence: number): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $inc: {
          'confidenceTelemetry.evaluatedCount': 1,
          'confidenceTelemetry.confidenceSum': confidence,
        },
        $min: { 'confidenceTelemetry.minConfidence': confidence },
      }
    );
  }

  /**
   * Increment the count of times the gate actually fired and paused the run
   * (#56 M1.1). The numerator to `recordIterationConfidence`'s denominator.
   */
  async recordGateEmitted(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $inc: { 'confidenceTelemetry.emittedCount': 1 } });
  }

  async addIterationBilling(id: string, billing: IIterationBilling): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $push: { iterationBilling: billing },
        $inc: { totalCreditsUsed: billing.credits },
      }
    );
  }

  async markComplete(id: string, result: unknown): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'completed',
          result,
          completedAt: new Date(),
        },
      }
    );
  }

  async markFailed(id: string, error: { message: string; stack?: string; timedOut?: boolean }): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'failed',
          error,
          completedAt: new Date(),
        },
      }
    );
  }

  async markAborted(id: string, partialResult?: unknown): Promise<void> {
    const update: Record<string, unknown> = {
      status: 'aborted',
      abortedAt: new Date(),
      completedAt: new Date(),
    };
    if (partialResult !== undefined) {
      update.result = partialResult;
    }
    await this.model.updateOne({ _id: id }, { $set: update });
  }

  async setAbortFlag(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { abortedAt: new Date() } });
  }

  async checkAbortFlag(id: string): Promise<boolean> {
    const result = await this.model.findById(id, { abortedAt: 1 }).lean();
    return result?.abortedAt != null;
  }

  /**
   * Lean read for the polling fast-path on dispatched subagents. Returns only
   * the fields needed to decide whether to keep polling or to inject a terminal
   * result - avoids loading the potentially-large `checkpoint`, `steps[]`, and
   * `iterationBilling[]` fields on every tick. Matches the projection-+-`.lean()`
   * pattern used by `checkAbortFlag`.
   */
  async getPollableStatus(id: string): Promise<{
    status: AgentExecutionStatus;
    result?: unknown;
    error?: { message: string; stack?: string; timedOut?: boolean };
    abortedAt?: Date;
  } | null> {
    const doc = await this.model.findById(id, { status: 1, result: 1, error: 1, abortedAt: 1 }).lean<{
      status: AgentExecutionStatus;
      result?: unknown;
      error?: { message: string; stack?: string; timedOut?: boolean };
      abortedAt?: Date;
    }>();
    return doc ?? null;
  }

  async incrementLambdaInvocationCount(id: string): Promise<number> {
    const result = await this.model.findOneAndUpdate(
      { _id: id },
      { $inc: { lambdaInvocationCount: 1 } },
      { new: true, projection: { lambdaInvocationCount: 1 } }
    );
    return result?.lambdaInvocationCount ?? 0;
  }

  /**
   * Atomic write used when the parent runs out of Lambda time mid-poll on a synchronous
   * Lambda-dispatched child. Persists the checkpoint, transitions status to
   * `awaiting_subagent`, and records what the parent is waiting on - all in one update
   * so a Lambda kill cannot leave the doc in an inconsistent state (e.g., status updated
   * but checkpoint stale).
   */
  async setWaitingOnChild(id: string, waitingOnChild: IWaitingOnChild, checkpoint: unknown): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { waitingOnChild, status: 'awaiting_subagent', checkpoint } });
  }

  /**
   * Cleared when the continuation Lambda has fetched the child's terminal result and
   * is ready to resume normal iteration. Also transitions status back to `running`.
   *
   * **Filtered on `abortedAt` non-existence** to avoid resurrecting an aborted
   * execution. Race window: parent is `awaiting_subagent`, user aborts (sets
   * `abortedAt` + calls `markAborted` based on the in-memory status). If the
   * continuation Lambda CAS-claimed `awaiting_subagent -> running` between the
   * abort's status read and write, the `markAborted` write may land AFTER the
   * Lambda is already executing. Without this filter, `clearWaitingOnChild`
   * would silently overwrite `status: 'aborted'` back to `running`.
   *
   * Returns `true` when the doc was updated (parent was not aborted), `false`
   * when the update matched 0 documents (parent is aborted - caller should
   * bail instead of resuming iteration).
   */
  async clearWaitingOnChild(id: string): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, abortedAt: { $exists: false } },
      { $unset: { waitingOnChild: '' }, $set: { status: 'running' } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Increment the subagent-handoff counter. Kept separate from
   * `lambdaInvocationCount` so subagent-induced handoffs don't consume the
   * runaway-iteration budget that `MAX_LAMBDA_HANDOFFS` protects.
   */
  async incrementSubagentHandoffCount(id: string): Promise<number> {
    const result = await this.model.findOneAndUpdate(
      { _id: id },
      { $inc: { subagentHandoffCount: 1 } },
      { new: true, projection: { subagentHandoffCount: 1 } }
    );
    return result?.subagentHandoffCount ?? 0;
  }

  /**
   * Persist the `subagentConfig` snapshot on a child execution doc. Called by the
   * orchestrator after `tracker.onStart` but before the dispatch SQS send, so the
   * dispatched Lambda can reconstruct the agent.
   */
  async setSubagentConfig(id: string, subagentConfig: ISubagentConfig): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { subagentConfig } });
  }

  async addChildExecution(parentId: string, childId: string): Promise<void> {
    await this.model.updateOne({ _id: parentId }, { $addToSet: { childExecutionIds: childId } });
  }

  /**
   * Roll a child execution's credit usage up to the parent's `totalCreditsUsed`
   * counter. The child keeps its own `iterationBilling` for audit; the parent
   * just tracks the running total so `completed` events return an accurate
   * grand total without summing children at read time.
   */
  async incrementCreditsUsed(id: string, credits: number): Promise<void> {
    // Reject NaN/Infinity explicitly - `NaN <= 0` is false, so a buggy upstream
    // could otherwise reach `$inc` (MongoDB silently coerces NaN to 0).
    if (!Number.isFinite(credits) || credits <= 0) return;
    await this.model.updateOne({ _id: id }, { $inc: { totalCreditsUsed: credits } });
  }

  /**
   * Paginated, filterable list of a user's executions for the history viewer.
   *
   * Returns top-level executions only - synchronous in-process subagents
   * (`parentExecutionId` set, not background) are hidden because they surface
   * as nested steps inside their parent's iteration trace. Background children
   * are included since they outlive their parent and are independently billed
   * (same boundary used by `countActiveByUserId`).
   *
   * Projection deliberately excludes `checkpoint`, `iterationBilling`, and the
   * heavy parts of `result` - those are large and not needed in list views.
   * Detail fetch (`GET /api/agent-executions/[id]`) supplies the full trace
   * when a row is expanded.
   *
   * Cursor is an opaque `<isoCreatedAt>_<objectId>` keyset - the `_id`
   * tiebreaker prevents row loss when several rows share the same millisecond
   * at a page boundary (reachable when a parent batch-spawns background
   * children in one tick). The `{ userId: 1, createdAt: -1 }` index serves the
   * primary range scan; the per-(createdAt, _id) tiebreak is in-memory but
   * bounded to rows that share that exact millisecond.
   */
  async findByUserIdPaginated(
    userId: string,
    filters: ExecutionListFilters,
    paging: ExecutionListPaging
  ): Promise<{ items: AgentExecutionListItem[]; nextCursor: string | null }> {
    const baseQuery: Record<string, unknown> = {
      userId,
      $or: [{ parentExecutionId: { $exists: false } }, { isBackgroundExecution: true }],
    };
    if (filters.statuses?.length) baseQuery.status = { $in: filters.statuses };
    if (filters.models?.length) baseQuery.model = { $in: filters.models };

    const createdAtRange: Record<string, Date> = {};
    if (filters.fromDate) createdAtRange.$gte = filters.fromDate;
    if (filters.toDate) createdAtRange.$lte = filters.toDate;
    if (Object.keys(createdAtRange).length > 0) baseQuery.createdAt = createdAtRange;

    const credits: Record<string, number> = {};
    if (filters.minCredits != null) credits.$gte = filters.minCredits;
    if (filters.maxCredits != null) credits.$lte = filters.maxCredits;
    if (Object.keys(credits).length > 0) baseQuery.totalCreditsUsed = credits;

    // Compound keyset boundary: rows older than the cursor's createdAt, OR rows
    // at the same createdAt with a strictly-smaller _id. The parent-vs-bg
    // `$or` in baseQuery moves under `$and` so both predicates stay live -
    // two top-level `$or` keys on one query object would clobber each other.
    const query: Record<string, unknown> = { ...baseQuery };
    if (paging.before) {
      const parsed = parseExecutionListCursor(paging.before);
      if (parsed) {
        const tiebreakObjectId = new mongoose.Types.ObjectId(parsed.id);
        const parentOr = query.$or;
        delete query.$or;
        query.$and = [
          { $or: parentOr },
          {
            $or: [
              { createdAt: { $lt: parsed.createdAt } },
              { createdAt: parsed.createdAt, _id: { $lt: tiebreakObjectId } },
            ],
          },
        ];
      }
    }

    // Over-fetch by one to detect "has more" without a separate count query.
    const docs = await this.model
      .find(query, EXECUTION_LIST_PROJECTION)
      .sort({ createdAt: -1, _id: -1 })
      .limit(paging.limit + 1)
      .lean<ExecutionListLeanDoc[]>();

    const hasMore = docs.length > paging.limit;
    const trimmed = hasMore ? docs.slice(0, paging.limit) : docs;

    const items: AgentExecutionListItem[] = trimmed.map(toListItem);

    const lastDoc = trimmed[trimmed.length - 1];
    const nextCursor = hasMore && lastDoc ? encodeCursor(lastDoc.createdAt, lastDoc._id) : null;

    return { items, nextCursor };
  }

  // --- DAG decomposition (coordinate_task) ---

  /**
   * Persist the coordinator's decomposition on the parent execution. The
   * `toolUseId` is captured so the resume path knows which placeholder to
   * surgically replace with the aggregated DAG result.
   */
  async setDagSpec(id: string, dagSpec: IDagSpec): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { dagSpec } });
  }

  /**
   * Mark the parent as `awaiting_dag_children` and record what it's waiting on.
   * Mirrors `setWaitingOnChild` shape - the resume Lambda uses this to know
   * which child nodes are still in flight without re-scanning all siblings.
   */
  async setWaitingOnDagChildren(
    id: string,
    waitingOnDagChildren: IWaitingOnDagChildren,
    checkpoint?: unknown
  ): Promise<void> {
    const setOps: Record<string, unknown> = {
      waitingOnDagChildren,
      status: 'awaiting_dag_children',
    };
    if (checkpoint !== undefined) {
      setOps.checkpoint = checkpoint;
    }
    await this.model.updateOne({ _id: id }, { $set: setOps });
  }

  /**
   * Clear the waiting marker and transition the parent back to `running`.
   * Same `abortedAt`-not-exists filter as `clearWaitingOnChild` - prevents
   * resurrecting an execution the user aborted mid-DAG.
   */
  async clearWaitingOnDagChildren(id: string): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, abortedAt: { $exists: false } },
      { $unset: { waitingOnDagChildren: '' }, $set: { status: 'running' } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Lean projection of all DAG children of a parent - enough to compute the
   * ready set and the partial-completion report without loading checkpoints
   * or iteration billing on every completion handler tick.
   */
  async findDagChildrenLean(parentExecutionId: string): Promise<
    Array<{
      _id: unknown;
      dagNodeId?: string;
      status: AgentExecutionStatus;
      result?: unknown;
      error?: { message: string; stack?: string };
      blockedBy?: string[];
      totalCreditsUsed: number;
    }>
  > {
    return this.model
      .find(
        { parentExecutionId, dagNodeId: { $exists: true } },
        { _id: 1, dagNodeId: 1, status: 1, result: 1, error: 1, blockedBy: 1, totalCreditsUsed: 1 }
      )
      .lean();
  }
}

// --- Model & Export ---

const AgentExecutionModel =
  (mongoose.models['AgentExecution'] as unknown as mongoose.Model<IAgentExecution>) ||
  mongoose.model<IAgentExecution>('AgentExecution', AgentExecutionSchema);

export const agentExecutionRepository = new AgentExecutionRepository(AgentExecutionModel);

export default AgentExecutionModel;
