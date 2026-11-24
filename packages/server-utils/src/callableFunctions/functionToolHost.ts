import {
  projectFunctionSchema,
  reviewHash,
  type CallableFunctionCallSurface,
  type ICallableFunctionOfferable,
} from '@bike4mind/common';
import { callableFunctionRepository } from '@bike4mind/database';
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
import { dispatchFunctionCall, type DispatchFunctionCallResult } from './dispatch';
import { listOfferedCallableFunctions } from './registry';

/** The connection id and slug of the function offer, reserved for it in `RESERVED_MCP_CONNECTION_SLUGS`. */
export const FUNCTION_CONNECTION_ID = 'fn';

/** Functions are listed first, so they get their own share of the 40 custom tools a turn may carry. */
export const MAX_FUNCTION_TOOLS_PER_TURN = 20;

export type FunctionToolSurface = Extract<CallableFunctionCallSurface, 'chat' | 'agent'>;

export interface FunctionToolHostDeps {
  dispatch: typeof dispatchFunctionCall;
}

async function toOfferedTool(fn: ICallableFunctionOfferable): Promise<CustomMcpOfferedTool> {
  const llm = projectFunctionSchema(fn.contract, 'llm');
  const mcp = projectFunctionSchema(fn.contract, 'mcp');
  const hash = await reviewHash(fn.contract);
  return {
    name: fn.slug,
    description: llm.description,
    inputSchema: { ...llm.parameters },
    outputSchema: { ...mcp.outputSchema },
    // A function runs with no network and no state, so `default` approval runs it without a card.
    annotations: { readOnlyHint: true },
    approval: fn.approval ?? 'default',
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
    return textResult(
      {
        outcome: call.outcome,
        ...(call.reason ? { reason: call.reason } : {}),
        ...(call.problems?.length ? { problems: call.problems } : {}),
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
 * Offers the caller's live, turned-on functions as one `fn` connection beside custom connectors. Gated by the
 * callable functions setting alone, whatever custom MCP's setting is; every call goes through the dispatcher,
 * which checks the setting, owner, and status again.
 */
export function createFunctionToolHost(
  surface: FunctionToolSurface,
  deps: FunctionToolHostDeps = { dispatch: dispatchFunctionCall }
): CustomMcpToolHost {
  return {
    ownsConnection: connectionId => connectionId === FUNCTION_CONNECTION_ID,

    async listConnections(userId, options = {}) {
      if (!(await resolveCallableFunctionsEnabled({ id: userId }))) return [];
      const functions = (await listOfferedCallableFunctions({ id: userId }))
        // No one can answer a card in a headless turn, so an always-ask function would only stall it.
        .filter(fn => !(options.headless && fn.approval === 'always_ask'))
        .slice(0, MAX_FUNCTION_TOOLS_PER_TURN);
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

    async callTool({ connectionId, userId, toolName, args, approved }) {
      if (connectionId !== FUNCTION_CONNECTION_ID) return { result: textResult({ outcome: 'not_found' }, true) };
      const fn = await callableFunctionRepository.findBySlugForOwner(toolName, { ownerType: 'user', ownerKey: userId });
      if (!fn || fn.state !== 'live') {
        return { result: textResult({ outcome: 'refused', reason: 'not_live' }, true) };
      }
      if (fn.approval === 'always_ask' && !approved) {
        return { result: textResult({ outcome: 'refused', reason: 'approval_required' }, true) };
      }
      const call = await deps.dispatch({ caller: { id: userId }, functionId: fn.id, args, surface });
      return { result: toCallResult(call) };
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
