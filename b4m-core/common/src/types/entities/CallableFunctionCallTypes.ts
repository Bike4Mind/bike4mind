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
] as const;
export type CallableFunctionCallOutcome = (typeof CALLABLE_FUNCTION_CALL_OUTCOMES)[number];

export interface CallableFunctionCallRuntime {
  kind: string;
  version: string;
  lockHash?: string;
}

/**
 * One row per call, contract read, or refusal in `callablefunctioncalls`, kept 90 days. It records hashes and sizes only, never the
 * inputs or outputs.
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
  outcome: CallableFunctionCallOutcome;
  /** A fixed code, never text from the guest. */
  reason?: string;
  /** The guest exception's class name, never its message. */
  errorClass?: string;
}

export interface ICallableFunctionCallDocument extends ICallableFunctionCall, IMongoDocument {}
