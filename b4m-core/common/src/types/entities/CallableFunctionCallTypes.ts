import { IMongoDocument } from './common';

/** Where a function call came from. */
export const CALLABLE_FUNCTION_CALL_SURFACES = ['test', 'rest', 'chat', 'agent', 'mcp'] as const;
export type CallableFunctionCallSurface = (typeof CALLABLE_FUNCTION_CALL_SURFACES)[number];

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
 * One row per call or refusal in `callablefunctioncalls`, kept 90 days. It records hashes and sizes only, never the
 * inputs or outputs.
 */
export interface ICallableFunctionCall {
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
