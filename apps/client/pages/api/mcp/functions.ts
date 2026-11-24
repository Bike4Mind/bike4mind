/**
 * POST /api/mcp/functions - an MCP endpoint (streamable HTTP, JSON responses) serving the key owner's live functions as
 * tools. Stateless: each request builds its own server and transport, so no session id is issued or honored.
 * The key's `functions:invoke` scope is the approval: the owner's own key always runs their live function.
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
  withinBudget,
} from '@server/callableFunctions/publicFunctions';

const SERVER_INFO = { name: 'bike4mind-functions', version: '1.0.0' };

/** The transport reads only these; the credential and any session id stay out of it. */
const FORWARDED_HEADERS = ['accept', 'content-type', 'mcp-protocol-version'];

interface Caller {
  userId: string;
  apiKeyId: string;
}

async function listTools(caller: Caller): Promise<Tool[]> {
  const user = { id: caller.userId };
  const live = await listLiveFunctions(user);
  const details = await Promise.all(live.map(fn => loadLiveFunction(user, fn.id)));
  return details.map(fn => {
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
  const fn = (await listLiveFunctions({ id: caller.userId })).find(live => live.slug === name);
  if (!fn) return toolError(FUNCTION_NOT_FOUND_MESSAGE);

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

function buildServer(caller: Caller): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(caller) }));
  server.setRequestHandler(CallToolRequestSchema, async request =>
    callTool(caller, request.params.name, request.params.arguments)
  );
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

    const server = buildServer({ userId: req.user.id, apiKeyId });
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
