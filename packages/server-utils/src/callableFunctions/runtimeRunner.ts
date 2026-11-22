import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { parseFunctionContract, type FunctionContractProblem } from '@bike4mind/common';
import {
  CALLABLE_FUNCTION_OUTCOMES,
  CALLABLE_FUNCTION_REASONS,
  runCallableFunctionInChild,
  type CallableFunctionChildOptions,
  type CallableFunctionRunPayload,
  type CallableFunctionRunResult,
} from './runtimeParent';

/**
 * Runs Python functions in an isolated runtime: the hosted Lambda (`apps/workers/src/callableFunctions/handler.ts`)
 * or, for tests and self-hosted development, the same child spawned on this host.
 */
export type CallableFunctionRunner = (payload: CallableFunctionRunPayload) => Promise<CallableFunctionRunResult>;

export function createInProcessCallableFunctionRunner(options: CallableFunctionChildOptions): CallableFunctionRunner {
  return payload => runCallableFunctionInChild(payload, options);
}

const OUTCOMES: ReadonlySet<string> = new Set(CALLABLE_FUNCTION_OUTCOMES);
const REASONS: ReadonlySet<string> = new Set(CALLABLE_FUNCTION_REASONS);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rebuilds a run result from the Lambda's reply, keeping only known fields; null if it is not one. */
export function parseCallableFunctionRunResult(raw: unknown): CallableFunctionRunResult | null {
  if (!isObject(raw) || typeof raw.outcome !== 'string' || !OUTCOMES.has(raw.outcome)) return null;
  if (typeof raw.durationMs !== 'number') return null;
  const result: CallableFunctionRunResult = {
    outcome: raw.outcome as CallableFunctionRunResult['outcome'],
    durationMs: raw.durationMs,
  };
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string' || !REASONS.has(raw.reason)) return null;
    result.reason = raw.reason as CallableFunctionRunResult['reason'];
  }
  if (typeof raw.errorClass === 'string') result.errorClass = raw.errorClass;
  if (typeof raw.printed === 'string') result.printed = raw.printed;
  if (typeof raw.initMs === 'number') result.initMs = raw.initMs;
  if (isObject(raw.value)) result.value = raw.value;
  if (raw.contract !== undefined) {
    const parsed = parseFunctionContract(raw.contract);
    if (!parsed.ok) return null;
    result.contract = parsed.contract;
  }
  if (Array.isArray(raw.problems)) {
    result.problems = raw.problems.filter(
      (problem): problem is FunctionContractProblem =>
        isObject(problem) && typeof problem.path === 'string' && typeof problem.message === 'string'
    );
  }
  return result;
}

// One attempt: a retry after a dropped connection would run the guest a second time.
let defaultLambdaClient: LambdaClient | undefined;
const sendWithDefaultClient = (command: InvokeCommand) =>
  (defaultLambdaClient ??= new LambdaClient({ maxAttempts: 1 })).send(command);

const FAILED_MESSAGE = 'Callable function runtime invocation failed';

/**
 * Invokes the runtime Lambda named by configuration, RequestResponse only. Any failure is a plain
 * Error with fixed text; the cause keeps an error name for operators, never the reply body.
 */
export function createLambdaCallableFunctionRunner(
  functionName: string,
  send: (command: InvokeCommand) => Promise<{ FunctionError?: string; Payload?: Uint8Array }> = sendWithDefaultClient
): CallableFunctionRunner {
  const failed = (cause?: unknown) => new Error(FAILED_MESSAGE, { cause });
  return async payload => {
    let reply: { FunctionError?: string; Payload?: Uint8Array };
    try {
      reply = await send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(payload)),
        })
      );
    } catch (error) {
      throw failed(error instanceof Error ? error.name : 'unknown');
    }
    if (reply.FunctionError) throw failed(`FunctionError: ${reply.FunctionError}`);
    if (!reply.Payload) throw failed('no payload');
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(reply.Payload).toString('utf8'));
    } catch (error) {
      throw failed(error instanceof Error ? error.name : 'unknown');
    }
    const result = parseCallableFunctionRunResult(body);
    if (!result) throw failed('malformed result');
    return result;
  };
}
