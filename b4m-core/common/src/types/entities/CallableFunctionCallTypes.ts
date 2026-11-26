import type { CallableFunctionTrustLabel } from './CallableFunctionTypes';
import { IMongoDocument } from './common';

/** Where a function call came from. */
export const CALLABLE_FUNCTION_CALL_SURFACES = ['test', 'rest', 'chat', 'agent', 'mcp'] as const;
export type CallableFunctionCallSurface = (typeof CALLABLE_FUNCTION_CALL_SURFACES)[number];

/** What the run was for: a call of `run`, or the server's read of `FUNCTION` from the pinned code. */
export const CALLABLE_FUNCTION_CALL_OPS = ['call', 'read_contract'] as const;
export type CallableFunctionCallOp = (typeof CALLABLE_FUNCTION_CALL_OPS)[number];

/** How a call ended; the server runtime's results use the same names. */
export const CALLABLE_FUNCTION_CALL_OUTCOMES = [
  'ok',
  'input_invalid',
  'output_invalid',
  'error',
  'timeout',
  'memory',
  'output_too_large',
  'refused',
  /** A pinned data file's bytes did not match its sha256, so the guest never ran. */
  'data_mismatch',
] as const;
export type CallableFunctionCallOutcome = (typeof CALLABLE_FUNCTION_CALL_OUTCOMES)[number];

/** How an asynchronous call can end: a run's outcomes, or `cancelled` by its caller, which no run answers. */
export const CALLABLE_FUNCTION_RESULT_OUTCOMES = [...CALLABLE_FUNCTION_CALL_OUTCOMES, 'cancelled'] as const;
export type CallableFunctionResultOutcome = (typeof CALLABLE_FUNCTION_RESULT_OUTCOMES)[number];

/** An asynchronous call's row reads `queued`, then `running`, until it is overwritten with how the call ended. */
export const CALLABLE_FUNCTION_CALL_PENDING_OUTCOMES = ['queued', 'running'] as const;
export type CallableFunctionCallPendingOutcome = (typeof CALLABLE_FUNCTION_CALL_PENDING_OUTCOMES)[number];

export const CALLABLE_FUNCTION_CALL_ROW_OUTCOMES = [
  ...CALLABLE_FUNCTION_RESULT_OUTCOMES,
  ...CALLABLE_FUNCTION_CALL_PENDING_OUTCOMES,
] as const;
export type CallableFunctionCallRowOutcome = (typeof CALLABLE_FUNCTION_CALL_ROW_OUTCOMES)[number];

export interface CallableFunctionCallRuntime {
  kind: string;
  version: string;
  lockHash?: string;
}

/**
 * One row per call, contract read, or refusal in `callablefunctioncalls`, kept 90 days. It records hashes and sizes
 * only, never the inputs or outputs.
 */
export interface ICallableFunctionCall {
  op: CallableFunctionCallOp;
  functionId: string;
  /** Absent when the record was not found. */
  ownerUserId?: string;
  callerUserId: string;
  apiKeyId?: string;
  organizationId?: string;
  surface: CallableFunctionCallSurface;
  pinSeq?: number;
  /** The pinned code's content hash. */
  codeHash?: string;
  /** sha256 of the canonical JSON of the inputs. */
  inputHash?: string;
  dataHashes: string[];
  runtime?: CallableFunctionCallRuntime;
  startedAt: Date;
  durationMs: number;
  initMs?: number;
  inputBytes?: number;
  outputBytes?: number;
  outcome: CallableFunctionCallRowOutcome;
  /** A fixed code, never text from the guest. */
  reason?: string;
  /** The guest exception's class name, never its message. */
  errorClass?: string;
}

export interface ICallableFunctionCallDocument extends ICallableFunctionCall, IMongoDocument {}

/** One file a call read at `/data/<name>`; `fetched_at` only for a source fetched during the call. */
export interface CallableFunctionStampData {
  name: string;
  mode: 'pinned' | 'live';
  sha256: string;
  bytes: number;
  fetched_at?: string;
}

/** What a call ran on. Room for output hashes beside `data` later; nothing here assumes every output is inline. */
export interface CallableFunctionStamp {
  function_id: string;
  slug: string;
  pin_version: number;
  /** Null until the pin is promoted. */
  pin_seq: number | null;
  code_hash: string;
  input_hash: string;
  runtime: { kind: string; version: string; lock_hash: string | null };
  packages: { name: string; version: string }[];
  /** One entry per data file the call could read, in pin order. */
  data: CallableFunctionStampData[];
  uses: never[];
  /** Null unless the function is live. */
  trust_label: CallableFunctionTrustLabel | null;
  surface: CallableFunctionCallSurface;
  duration_ms: number;
  called_at: string;
}

/** The owner's own calls of one function over a window: counts by outcome and the latest few, never inputs. */
export interface CallableFunctionCallSummary {
  since: Date;
  total: number;
  outcomes: Partial<Record<CallableFunctionCallRowOutcome, number>>;
  recent: {
    id: string;
    startedAt: Date;
    outcome: CallableFunctionCallRowOutcome;
    surface: CallableFunctionCallSurface;
    /** Made by someone the function is shared with, not the owner; who it was is not shown. */
    byRecipient: boolean;
    /** The promotion that ran; absent when the call was refused before a pin was read. */
    pinSeq?: number;
    durationMs: number;
    /**
     * Only on the owner's own calls made with one of their API keys: the key's name, or null once it is deleted.
     * Never on a recipient's call.
     */
    apiKey?: { name: string | null };
  }[];
}

/** How long an asynchronous call's result is kept, and the most its outputs may take as JSON. */
export const CALLABLE_FUNCTION_RESULT_TTL_SECONDS = 24 * 60 * 60;
export const CALLABLE_FUNCTION_RESULT_MAX_BYTES = 5 * 1024 * 1024;

export const CALLABLE_FUNCTION_RESULT_STATES = ['queued', 'running', 'finished'] as const;
export type CallableFunctionResultState = (typeof CALLABLE_FUNCTION_RESULT_STATES)[number];

/**
 * One asynchronous call in `callablefunctionresults`, keyed by its call-log row's id and kept 24 hours. The inputs
 * are held only until the run starts; the outputs and stamp are what the caller polls for.
 */
export interface ICallableFunctionResult {
  callId: string;
  callerUserId: string;
  functionId: string;
  apiKeyId?: string;
  /** The organization the call was made in, so the queued run makes its checks as the caller did. */
  organizationId?: string;
  state: CallableFunctionResultState;
  input?: Record<string, unknown>;
  outcome?: CallableFunctionResultOutcome;
  reason?: string;
  errorClass?: string;
  problems?: { path: string; message: string }[];
  outputs?: Record<string, unknown>;
  stamp?: CallableFunctionStamp;
  createdAt: Date;
}

export interface ICallableFunctionResultDocument extends ICallableFunctionResult, IMongoDocument {}
