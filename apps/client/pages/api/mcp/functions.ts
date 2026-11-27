/**
 * POST /api/mcp/functions - an MCP endpoint (streamable HTTP, JSON responses) serving as tools the functions the key's
 * owner can call: their own live ones and those shared with them and reviewed. Stateless: each request builds its own
 * server and transport, so no session id is issued or honored. The key's `functions:invoke` scope is the approval.
 */
import type { Request } from 'express';
import { ApiKeyScope, ForbiddenError, projectFunctionSchema } from '@bike4mind/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveCallableFunctionsMcpEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { findCallerFunction } from '@bike4mind/server-utils/callableFunctions/callerFunctions';
import {
  CALLABLE_FUNCTION_SURFACE_CAPS,
  dispatchFunctionCall,
  recordCallableFunctionRefusal,
} from '@bike4mind/server-utils/callableFunctions/dispatch';
import { FUNCTION_MIN_WAIT_MS } from '@bike4mind/server-utils/callableFunctions/functionToolHost';
import { baseApi } from '@server/middlewares/baseApi';
import {
  FUNCTION_INVOKE_MAX_BODY_BYTES,
  FUNCTION_INVOKE_RUN_TIMEOUT_MS,
  FUNCTION_NOT_FOUND_MESSAGE,
  functionsRateLimit,
  invokeAnswer,
  listLiveFunctions,
  OUTPUT_TOO_LARGE_MESSAGE,
} from '@server/callableFunctions/publicFunctions';

// Under the 6 MB Lambda response limit, which the answer reaches escaped a second time.
const MAX_ANSWER_BYTES = 5 * 1024 * 1024;

const FUNCTION_MCP_BUDGET_MS = CALLABLE_FUNCTION_SURFACE_CAPS.mcp.waitMs;

const SERVER_INFO = { name: 'bike4mind-functions', version: '1.0.0' };

/** The transport reads only these; the credential and any session id stay out of it. */
const FORWARDED_HEADERS = ['accept', 'content-type', 'mcp-protocol-version'];

interface Caller {
  userId: string;
  apiKeyId: string;
  /** Epoch ms at which the whole request, its setting and lookup reads included, must be answered. */
  deadline: number;
}

async function listTools(caller: Caller): Promise<Tool[]> {
  return (await listLiveFunctions({ id: caller.userId })).map(({ fn, name }) => {
    const { description, inputSchema, outputSchema } = projectFunctionSchema(fn.contract, 'mcp');
    return {
      name,
      description,
      inputSchema: { ...inputSchema },
      outputSchema: { ...outputSchema },
      annotations: { readOnlyHint: true },
    };
  });
}

const toolError = (text: string, meta: { stamp?: unknown; problems?: unknown } = {}): CallToolResult => {
  const { stamp, problems } = meta;
  return {
    content: [{ type: 'text', text }],
    isError: true,
    ...(stamp || problems ? { _meta: { ...(stamp ? { stamp } : {}), ...(problems ? { problems } : {}) } } : {}),
  };
};

// Refusals and failures come back as an isError result, as the SDK's McpServer answers its own tool errors.
async function callTool(caller: Caller, name: string, args: unknown): Promise<CallToolResult> {
  const user = { id: caller.userId };
  const request = { caller: user, surface: 'mcp' as const, apiKeyId: caller.apiKeyId };
  const lookup = await findCallerFunction(user, { name });
  if (!('found' in lookup)) {
    if (lookup.refused === 'not_live') {
      await recordCallableFunctionRefusal({ ...request, functionId: lookup.fn.id }, 'not_live', lookup.fn);
    } else {
      await recordCallableFunctionRefusal({ ...request, functionId: name }, 'not_found');
    }
    return toolError(FUNCTION_NOT_FOUND_MESSAGE);
  }

  const call = await dispatchFunctionCall(
    { ...request, functionId: lookup.found.fn.id, args: args ?? {} },
    { timeoutMs: FUNCTION_INVOKE_RUN_TIMEOUT_MS, deadline: caller.deadline, minWaitMs: FUNCTION_MIN_WAIT_MS }
  );
  const answer = invokeAnswer(call);
  if (answer.status !== 200) {
    return toolError(String(answer.body.error), { stamp: answer.body.stamp, problems: answer.body.problems });
  }
  const output = call.outputs ?? {};
  const result: CallToolResult = {
    // The output alone, so it matches the tool's outputSchema; the stamp rides in _meta and the text block.
    structuredContent: output,
    content: [{ type: 'text', text: JSON.stringify({ output, stamp: call.stamp }) }],
    _meta: { stamp: call.stamp },
  };
  // The body travels as an escaped string inside the Lambda payload, so measure it stringified twice.
  if (Buffer.byteLength(JSON.stringify(JSON.stringify(result))) > MAX_ANSWER_BYTES) {
    return toolError(OUTPUT_TOO_LARGE_MESSAGE, { stamp: call.stamp });
  }
  return result;
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

const HANDSHAKE_METHODS = new Set(['initialize', 'notifications/initialized']);

/**
 * The two messages a stateless client sends ahead of every tool call. They run no function and answer a fixed
 * body, so charging them would bill each tool call three times against a key's limit.
 */
function isHandshake(req: Pick<Request, 'body'>): boolean {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { method } = body as { method?: unknown };
  return typeof method === 'string' && HANDSHAKE_METHODS.has(method);
}

const userRateLimit = functionsRateLimit('/api/mcp/functions');

const handler = baseApi({
  requiredScopes: [ApiKeyScope.FUNCTIONS_INVOKE],
  allowedMethods: ['POST'],
  maxBodySize: FUNCTION_INVOKE_MAX_BODY_BYTES,
  skipApiKeyRateLimit: isHandshake,
  authChallenge: 'Bearer',
})
  .use((req, res, next) => (isHandshake(req) ? next() : userRateLimit(req, res, next)))
  .post(async (req, res) => {
    const deadline = Date.now() + FUNCTION_MCP_BUDGET_MS;
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

    const server = buildServer({ userId: req.user.id, apiKeyId, deadline }, (message, context) =>
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
