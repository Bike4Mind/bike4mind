import {
  CALLABLE_FUNCTION_TOOL_CONNECTION_ID as FUNCTION_CONNECTION_ID,
  MAX_CALLABLE_FUNCTIONS_PER_TURN,
  projectFunctionSchema,
  reviewHash,
  type CallableFunctionCallSurface,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  isCustomToolOffered,
  type CustomMcpConnectionOffer,
  type CustomMcpOfferedTool,
  type CustomMcpToolCallResult,
  type CustomMcpToolHost,
} from '@bike4mind/services/llm';
import { customMcpToolHost } from '../mcpConnections/customMcpToolHost';
import { resolveCallableFunctionsEnabled } from './access';
import { composeToolHosts } from './composeToolHosts';
import {
  dispatchFunctionCall,
  recordCallableFunctionRefusal,
  type CallableFunctionDispatchOptions,
  type DispatchFunctionCallRequest,
  type DispatchFunctionCallResult,
} from './dispatch';
import { findCallerFunction, listCallerFunctions, type CallerFunction } from './callerFunctions';

export { FUNCTION_CONNECTION_ID };

/** Functions are listed first, so they get their own share of the 40 custom tools a turn may carry. */
export const MAX_FUNCTION_TOOLS_PER_TURN = MAX_CALLABLE_FUNCTIONS_PER_TURN;

export type FunctionToolSurface = Extract<CallableFunctionCallSurface, 'chat' | 'agent'>;

/** Kept back from the turn's deadline so the model can still answer after a call. */
export const FUNCTION_ANSWER_RESERVE_MS = 15_000;

/** With less wait than this left, the dispatcher refuses `budget_exhausted` without running. */
export const FUNCTION_MIN_WAIT_MS = 2_000;

/** The host only runs a call synchronously; it never queues one. */
export type FunctionToolDispatch = (
  request: DispatchFunctionCallRequest,
  options?: Pick<CallableFunctionDispatchOptions, 'deadline' | 'minWaitMs'>
) => Promise<DispatchFunctionCallResult>;

export interface FunctionToolHostDeps {
  dispatch: FunctionToolDispatch;
  recordRefusal: typeof recordCallableFunctionRefusal;
}

const TIMEOUT_MESSAGE = 'The function did not finish within the time this turn allows. Do not call it again this turn.';
const BUDGET_MESSAGE = 'Too little of this turn is left to run the function. Do not call it again this turn.';

async function toOfferedTool({ fn, name, approval }: CallerFunction): Promise<CustomMcpOfferedTool> {
  const llm = projectFunctionSchema(fn.contract, 'llm');
  const mcp = projectFunctionSchema(fn.contract, 'mcp');
  const hash = await reviewHash(fn.contract);
  return {
    name,
    description: llm.description,
    inputSchema: { ...llm.parameters },
    outputSchema: { ...mcp.outputSchema },
    // A function runs with no network and no state, so `default` approval runs it without a card.
    annotations: { readOnlyHint: true },
    approval,
    state: 'active',
    enabled: true,
    descriptionRawHash: hash,
    versionHash: hash,
    firstSeenAt: fn.createdAt,
  };
}

const textResult = (body: unknown, isError: boolean): CustomMcpToolCallResult => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
});

function toCallResult(call: DispatchFunctionCallResult): CustomMcpToolCallResult {
  if (call.outcome !== 'ok' || !call.outputs) {
    const message =
      call.outcome === 'timeout' ? TIMEOUT_MESSAGE : call.reason === 'budget_exhausted' ? BUDGET_MESSAGE : undefined;
    return textResult(
      {
        outcome: call.outcome,
        ...(call.reason ? { reason: call.reason } : {}),
        ...(call.problems?.length ? { problems: call.problems } : {}),
        ...(message ? { message } : {}),
      },
      true
    );
  }
  const stamp = { ...call.stamp };
  return {
    ...textResult({ output: call.outputs, stamp }, false),
    structuredContent: call.outputs,
    meta: stamp,
    ...(call.stamp?.trust_label ? { label: call.stamp.trust_label } : {}),
  };
}

/**
 * Offers the functions the caller can call (`listCallerFunctions`: their own live ones, then those shared with them
 * and reviewed) under an internal namespace beside custom connectors. Gated by the callable functions setting alone,
 * whatever custom MCP's setting is; every call goes through the dispatcher, which checks the setting, access,
 * review, and status again.
 */
export function createFunctionToolHost(
  surface: FunctionToolSurface,
  deps: Partial<FunctionToolHostDeps> = {}
): CustomMcpToolHost {
  const { dispatch = dispatchFunctionCall, recordRefusal = recordCallableFunctionRefusal } = deps;
  return {
    ownsConnection: connectionId => connectionId === FUNCTION_CONNECTION_ID,
    listsWithoutMcpServer: true,

    async listConnections(userId, options = {}) {
      if (!(await resolveCallableFunctionsEnabled({ id: userId }))) return [];
      // No one can answer a card in a headless turn, so an always-ask function would only stall it.
      const functions = await listCallerFunctions(
        { id: userId },
        { limit: MAX_FUNCTION_TOOLS_PER_TURN, excludeAlwaysAsk: options.headless }
      );
      if (functions.length === 0) return [];
      const offer: CustomMcpConnectionOffer = {
        connectionId: FUNCTION_CONNECTION_ID,
        slug: FUNCTION_CONNECTION_ID,
        displayName: 'Functions',
        urlHost: 'functions',
        allowWriteTools: true,
        requireApprovalForAll: false,
        tools: await Promise.all(functions.map(toOfferedTool)),
      };
      return [offer];
    },

    async callTool({ connectionId, userId, toolName, args, approved, deadline }) {
      const caller = { id: userId };
      try {
        if (connectionId !== FUNCTION_CONNECTION_ID) {
          await recordRefusal({ caller, functionId: toolName, surface }, 'not_found');
          return { result: textResult({ outcome: 'not_found' }, true) };
        }
        const lookup = await findCallerFunction(caller, { name: toolName });
        if (!('found' in lookup)) {
          const fn = lookup.refused === 'not_live' ? lookup.fn : undefined;
          await recordRefusal({ caller, functionId: fn?.id ?? toolName, surface }, lookup.refused, fn);
          return { result: textResult({ outcome: 'refused', reason: 'not_live' }, true) };
        }
        const { fn, approval } = lookup.found;
        if (approval === 'always_ask' && !approved) {
          await recordRefusal({ caller, functionId: fn.id, surface }, 'approval_required', fn);
          return { result: textResult({ outcome: 'refused', reason: 'approval_required' }, true) };
        }
        const request = { caller, functionId: fn.id, args, surface, approved };
        const call =
          deadline === undefined
            ? await dispatch(request)
            : await dispatch(request, {
                deadline: deadline - FUNCTION_ANSWER_RESERVE_MS,
                minWaitMs: FUNCTION_MIN_WAIT_MS,
              });
        return { result: toCallResult(call) };
      } catch (error) {
        Logger.warn('[callableFunctions] Function dispatch threw', {
          slug: toolName,
          error: error instanceof Error ? error.message : String(error),
        });
        return { result: textResult({ outcome: 'error', reason: 'dispatch_failed' }, true) };
      }
    },
  };
}

/** What chat and agent runs inject as `customMcp`: functions first, then the person's connectors. */
export const functionAndConnectorToolHost = (surface: FunctionToolSurface): CustomMcpToolHost =>
  composeToolHosts(createFunctionToolHost(surface), customMcpToolHost);

/** Whether the confirm route may still run this function's card: offered now, as listing would offer it. */
export async function isFunctionToolStillOffered(userId: string, toolName: string): Promise<boolean> {
  const [offer] = await createFunctionToolHost('chat').listConnections(userId);
  const tool = offer?.tools.find(candidate => candidate.name === toolName);
  return Boolean(offer && tool && isCustomToolOffered(tool, offer));
}
