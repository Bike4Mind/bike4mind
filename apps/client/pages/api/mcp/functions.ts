/**
 * POST /api/mcp/functions - an MCP endpoint (streamable HTTP, JSON responses) serving the key owner's live functions as
 * tools. Stateless: each request builds its own server and transport, so no session id is issued or honored.
 * The key's `functions:invoke` scope is the approval: the owner's own key always runs their live function.
 */
import type { Request } from 'express';
import { ApiKeyScope, ForbiddenError, NotFoundError, projectFunctionSchema } from '@bike4mind/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveCallableFunctionsMcpEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { dispatchFunctionCall } from '@bike4mind/server-utils/callableFunctions/dispatch';
import { baseApi } from '@server/middlewares/baseApi';
import {
  FUNCTION_INVOKE_BUDGET_MS,
  FUNCTION_INVOKE_MAX_BODY_BYTES,
  FUNCTION_INVOKE_RUN_TIMEOUT_MS,
  FUNCTION_NOT_FOUND_MESSAGE,
  functionsRateLimit,
  invokeAnswer,
  listLiveFunctions,
  loadLiveFunction,
  loadLiveFunctionBySlug,
  withinBudget,
} from '@server/callableFunctions/publicFunctions';

const SERVER_INFO = { name: 'bike4mind-functions', version: '1.0.0' };

/** The transport reads only these; the credential and any session id stay out of it. */
const FORWARDED_HEADERS = ['accept', 'content-type', 'mcp-protocol-version'];

interface Caller {
  userId: string;
  apiKeyId: string;
}

/** A function that left `live` after the list was read drops out of the answer instead of failing it. */
async function listTools(caller: Caller): Promise<Tool[]> {
  const user = { id: caller.userId };
  const live = await listLiveFunctions(user);
  const loaded = await Promise.all(
    live.map(fn =>
      loadLiveFunction(user, fn.id).catch(error => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })
    )
  );
  return loaded
    .flatMap(fn => (fn ? [fn] : []))
    .map(fn => {
      const { description, inputSchema, outputSchema } = projectFunctionSchema(fn.contract, 'mcp');
      return {
        name: fn.slug,
        description,
        inputSchema: { ...inputSchema },
        outputSchema: { ...outputSchema },
        annotations: { readOnlyHint: true },
      };
    });
}

const toolError = (text: string, stamp?: unknown): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
  ...(stamp ? { _meta: { stamp } } : {}),
});

// Refusals and failures come back as an isError result, as the SDK's McpServer answers its own tool errors.
async function callTool(caller: Caller, name: string, args: unknown): Promise<CallToolResult> {
  let fn: { id: string };
  try {
    fn = await loadLiveFunctionBySlug({ id: caller.userId }, name);
  } catch (error) {
    if (error instanceof NotFoundError) return toolError(FUNCTION_NOT_FOUND_MESSAGE);
    throw error;
  }

  const call = await withinBudget(
    dispatchFunctionCall(
      { caller: { id: caller.userId }, functionId: fn.id, args: args ?? {}, surface: 'mcp', apiKeyId: caller.apiKeyId },
      { timeoutMs: FUNCTION_INVOKE_RUN_TIMEOUT_MS }
    ),
    FUNCTION_INVOKE_BUDGET_MS
  );
  if (!call) return toolError('The call ran past its time limit.');

  const answer = invokeAnswer(call);
  if (answer.status !== 200) return toolError(String(answer.body.error), answer.body.stamp);
  const output = call.outputs ?? {};
  return {
    // The output alone, so it matches the tool's outputSchema; the stamp rides in _meta and the text block.
    structuredContent: output,
    content: [{ type: 'text', text: JSON.stringify({ output, stamp: call.stamp }) }],
    _meta: { stamp: call.stamp },
  };
}

const INTERNAL_ERROR_MESSAGE = 'Internal error';

type LogError = (message: string, context: { name: string; message: string }) => void;

function logFailure(logError: LogError, method: string, error: unknown) {
  const cause = error instanceof Error ? error : new Error(String(error));
  logError(`[mcp/functions] ${method} failed`, { name: cause.name, message: cause.message });
}

function buildServer(caller: Caller, logError: LogError): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return { tools: await listTools(caller) };
    } catch (error) {
      logFailure(logError, 'tools/list', error);
      throw new Error(INTERNAL_ERROR_MESSAGE);
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      return await callTool(caller, request.params.name, request.params.arguments);
    } catch (error) {
      logFailure(logError, 'tools/call', error);
      return toolError(INTERNAL_ERROR_MESSAGE);
    }
  });
  return server;
}

function toWebRequest(req: Request): globalThis.Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return new globalThis.Request(`http://localhost${req.url ?? '/api/mcp/functions'}`, { method: 'POST', headers });
}

const handler = baseApi({
  requiredScopes: [ApiKeyScope.FUNCTIONS_INVOKE],
  allowedMethods: ['POST'],
  maxBodySize: FUNCTION_INVOKE_MAX_BODY_BYTES,
})
  .use(functionsRateLimit('/api/mcp/functions'))
  .post(async (req, res) => {
    const apiKeyId = req.apiKeyInfo?.keyId;
    if (!apiKeyId) throw new ForbiddenError('This endpoint takes an API key holding the functions:invoke scope.');
    if (!(await resolveCallableFunctionsMcpEnabled(req.user))) {
      throw new ForbiddenError('Callable functions over MCP are turned off for this account.');
    }

    // The 2025-06-18 protocol dropped batching; one message per request keeps the limiter's count honest.
    if (Array.isArray(req.body)) {
      return res
        .status(400)
        .json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one message per request.' } });
    }

    const server = buildServer({ userId: req.user.id, apiKeyId }, (message, context) =>
      req.logger.error(message, context)
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const answer = await transport.handleRequest(toWebRequest(req), { parsedBody: req.body });
      answer.headers.forEach((value, name) => res.setHeader(name, value));
      const body = await answer.text();
      res.status(answer.status);
      return body ? res.send(body) : res.end();
    } finally {
      await server.close();
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
    // Must cover FUNCTION_INVOKE_MAX_BODY_BYTES, which baseApi checks first.
    bodyParser: { sizeLimit: '6mb' },
  },
};
