import { z } from 'zod';
import { B4mApiError } from '@bike4mind/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiErrorRetryAfterSeconds, mapApiError, type B4mApiClient } from './b4mApiClient.js';
import type { ToolMeta } from './tools.js';

const SCOPE = 'functions:invoke';
const FUNCTION_ID_PATTERN = /^[a-f0-9]{24}$/i;
const SLUG_PAGE_SIZE = 100;
const SLUG_MAX_PAGES = 10;

export const FUNCTION_TOOL_META: ToolMeta[] = [
  {
    name: 'list_functions',
    title: 'List functions',
    description:
      "List the key owner's live functions: Python artifacts promoted after their tests passed on the server. " +
      'Each comes with its id, slug, `input_schema` (what call_function takes; number fields name their `unit`), ' +
      'and `output_schema`. Pass `next_cursor` back as `cursor` until it is null.',
    scope: SCOPE,
  },
  {
    name: 'call_function',
    title: 'Call function',
    description:
      'Run one live function on the server by its id or slug with `input` fitting its `input_schema` from ' +
      'list_functions. Returns `output` and `stamp`: the pin, code hash, input hash, runtime, and packages the call ' +
      'ran on, so the result can be traced and repeated.',
    scope: SCOPE,
  },
];

const listFunctionsShape = {
  limit: z.number().int().min(1).max(25).optional().describe('Functions per page (default 10).'),
  cursor: z.string().optional().describe('The `next_cursor` of the previous page.'),
};

const callFunctionShape = {
  function: z.string().min(1).describe('The function id or slug, as list_functions shows it.'),
  input: z.record(z.string(), z.unknown()).describe("The function's inputs, as its `input_schema` describes them."),
};

const NOT_ENABLED_FIX = 'Ask an admin to turn on callable functions for this account and its organizations.';
const KEY_FIX =
  'Create a key with the Functions access level in the API tab of your Bike4Mind profile and set it as B4M_API_KEY.';
const LIST_FIX = 'Call list_functions for the functions this key can call.';

function errorBody(error: unknown): Record<string, unknown> {
  const body = error instanceof B4mApiError ? error.body : undefined;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/** One message per refusal of the functions API, each naming what to do next. */
export function functionErrorMessage(error: unknown, baseURL: string, ref?: string): string {
  if (!(error instanceof B4mApiError)) return mapApiError(error, baseURL, SCOPE);
  const body = errorBody(error);
  const message = typeof body.error === 'string' ? body.error : undefined;
  const which = ref ? `"${ref}"` : 'that function';
  switch (error.status) {
    case 403:
      if (Array.isArray(body.required_scopes)) return `This API key does not hold ${SCOPE}. ${KEY_FIX}`;
      if (message) return `${message} ${NOT_ENABLED_FIX}`;
      break;
    case 404:
      // A 404 without the JSON envelope is a server without these routes; mapApiError says so.
      if (message) {
        return `No live function ${which} belongs to this key's owner. ${LIST_FIX} A draft or turned-off function must be promoted in Bike4Mind first.`;
      }
      break;
    case 413:
      return 'The input is larger than a call accepts. Send a smaller input.';
    case 422: {
      const problems = Array.isArray(body.problems)
        ? body.problems.flatMap(p => {
            const { path, message: why } = (p ?? {}) as { path?: unknown; message?: unknown };
            return typeof path === 'string' && typeof why === 'string' ? [`${path || 'input'} ${why}`] : [];
          })
        : [];
      const detail = problems.length > 0 ? ` Fix: ${problems.join('; ')}.` : '';
      return `${message ?? 'The input does not fit the input schema.'}${detail} Read the input_schema from list_functions and call again.`;
    }
    case 429: {
      const wait = apiErrorRetryAfterSeconds(error);
      return `Too many function requests for this account. Retry ${wait === undefined ? 'in a minute' : `after ${wait}s`}.`;
    }
    case 502: {
      const outcome = typeof body.outcome === 'string' ? ` (outcome: ${body.outcome})` : '';
      return `${message ?? 'The function failed.'}${outcome} The inputs fit; check the function's code in Bike4Mind or call it with other inputs.`;
    }
    case 503:
      return `No function runtime is available on the Bike4Mind server at ${baseURL}. Try again later, or ask an admin to set one up.`;
    case 504:
      return 'The call ran past its time limit and was stopped. Try smaller inputs, or run the function in the Bike4Mind app.';
  }
  return mapApiError(error, baseURL, SCOPE);
}

export async function listFunctions(client: B4mApiClient, args: { limit?: number; cursor?: string }) {
  const page = await client.listFunctions(args.limit ?? 10, args.cursor);
  const functions = await Promise.all(page.data.map(fn => client.getFunction(fn.id)));
  return { functions, next_cursor: page.next_cursor };
}

/** An id as given; a slug looked up among the owner's live functions, since the API addresses functions by id. */
export async function resolveFunctionId(client: B4mApiClient, ref: string): Promise<string> {
  if (FUNCTION_ID_PATTERN.test(ref)) return ref;
  let cursor: string | undefined;
  for (let i = 0; i < SLUG_MAX_PAGES; i++) {
    const page = await client.listFunctions(SLUG_PAGE_SIZE, cursor);
    const match = page.data.find(fn => fn.slug === ref);
    if (match) return match.id;
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  throw new Error(`No live function has the slug "${ref}". ${LIST_FIX}`);
}

export async function callFunction(client: B4mApiClient, args: { function: string; input: Record<string, unknown> }) {
  const id = await resolveFunctionId(client, args.function);
  const { output, stamp } = await client.invokeFunction(id, args.input);
  return { output, stamp };
}

export function registerFunctionTools(server: McpServer, client: B4mApiClient): void {
  const meta = (name: string) => FUNCTION_TOOL_META.find(t => t.name === name)!;
  // Result shapes match toResult and errorResult in tools.ts, which imports this module.
  const run = async (fn: () => Promise<Record<string, unknown>>, ref?: string): Promise<CallToolResult> => {
    try {
      const value = await fn();
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
    } catch (error) {
      const text = functionErrorMessage(error, client.baseURL, ref);
      return { content: [{ type: 'text', text }], isError: true };
    }
  };

  server.registerTool(
    'list_functions',
    {
      title: meta('list_functions').title,
      description: meta('list_functions').description,
      inputSchema: listFunctionsShape,
      annotations: { readOnlyHint: true },
    },
    args => run(() => listFunctions(client, args))
  );
  server.registerTool(
    'call_function',
    {
      title: meta('call_function').title,
      description: meta('call_function').description,
      inputSchema: callFunctionShape,
      annotations: { readOnlyHint: true },
    },
    args => run(() => callFunction(client, args), args.function)
  );
}
