import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
// Each listed function costs one detail request, and the detail route allows 10 a minute on the lowest plan.
const LIST_PAGE_MAX = 8;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const OUTPUT_TOO_LARGE =
  'output_too_large: The result is over the 2 MiB limit for one tool result, so none of it is returned. Call the function with inputs that produce a smaller output.';

/** Where a `list_functions` page resumes: the server's cursor, the id of the last function read, and the page size. */
const listCursorSchema = z.object({
  c: z.string().nullable(),
  a: z.string().regex(FUNCTION_ID_PATTERN).nullable(),
  n: z.number().int().min(1).max(LIST_PAGE_MAX),
});
type ListCursor = z.infer<typeof listCursorSchema>;

const CURSOR_KEY = randomBytes(32);
const BAD_CURSOR = 'That cursor did not come from list_functions. Call list_functions again without a cursor.';

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
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_PAGE_MAX)
    .optional()
    .describe(`Functions per page (default ${LIST_PAGE_MAX}).`),
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
  if (error.status >= 300 && error.status < 400) {
    return `The Bike4Mind server at ${baseURL} redirected the request, and these tools do not follow redirects. Check that B4M_API_URL points at the server itself.`;
  }
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
      return `${message ?? `The function runtime on the Bike4Mind server at ${baseURL} did not answer.`} Try again in a minute; if it keeps happening, ask an admin.`;
    case 504:
      if (body.errorCode === 'request_timeout') {
        return `${message ?? 'The call ran past its time limit.'} It was stopped. Try smaller inputs, or run the function in the Bike4Mind app.`;
      }
      break;
  }
  return mapApiError(error, baseURL, SCOPE);
}

const sign = (payload: string) => createHmac('sha256', CURSOR_KEY).update(payload).digest();

function encodeListCursor(cursor: ListCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}

/** A cursor this process issued, or undefined for anything else. */
function decodeListCursor(cursor: string): ListCursor | undefined {
  const [payload, mac, ...rest] = cursor.split('.');
  if (!payload || !mac || rest.length > 0) return undefined;
  const expected = sign(payload);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const parsed = listCursorSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One function's detail is read at a time. A function that left live meanwhile is skipped; a rate limit ends
 * the page with a cursor holding the id of the last function read. The server lists by id, so a resume refetches
 * the page and keeps the functions after that id.
 */
export async function listFunctions(client: B4mApiClient, args: { limit?: number; cursor?: string }) {
  const resume = args.cursor === undefined ? undefined : decodeListCursor(args.cursor);
  if (args.cursor !== undefined && !resume) throw new Error(BAD_CURSOR);
  const size = resume?.n ?? args.limit ?? LIST_PAGE_MAX;
  const page = await client.listFunctions(size, resume?.c ?? undefined);
  const after = resume?.a;
  const pending = after ? page.data.filter(fn => fn.id > after) : page.data;
  const functions = [];
  for (let i = 0; i < pending.length; i++) {
    try {
      functions.push(await client.getFunction(pending[i].id));
    } catch (error) {
      if (!(error instanceof B4mApiError)) throw error;
      if (error.status === 404) continue;
      if (error.status === 429 && i > 0) {
        return { functions, next_cursor: encodeListCursor({ c: resume?.c ?? null, a: pending[i - 1].id, n: size }) };
      }
      throw error;
    }
  }
  const next_cursor = page.next_cursor ? encodeListCursor({ c: page.next_cursor, a: null, n: size }) : null;
  return { functions, next_cursor };
}

/** An id as given; a slug looked up among the owner's live functions, since the API addresses functions by id. */
export async function resolveFunctionId(
  client: B4mApiClient,
  ref: string,
  slugs: Map<string, string> = new Map()
): Promise<string> {
  if (FUNCTION_ID_PATTERN.test(ref)) return ref;
  let cursor: string | undefined;
  for (let i = 0; i < SLUG_MAX_PAGES; i++) {
    const page = await client.listFunctions(SLUG_PAGE_SIZE, cursor);
    const match = page.data.find(fn => fn.slug === ref);
    if (match) {
      slugs.set(ref, match.id);
      return match.id;
    }
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  throw new Error(`No live function has the slug "${ref}". ${LIST_FIX}`);
}

// The CLI never asks for async mode, so a queued answer means the server ignored the request's mode.
async function invokeSync(client: B4mApiClient, id: string, input: Record<string, unknown>) {
  const res = await client.invokeFunction(id, input);
  if (!('output' in res))
    throw new Error('The server queued the call instead of running it; the CLI calls functions synchronously.');
  return { output: res.output, stamp: res.stamp };
}

/** `slugs` keeps each resolved slug for the server's life: a slug is fixed and unique per owner. */
export async function callFunction(
  client: B4mApiClient,
  args: { function: string; input: Record<string, unknown> },
  slugs: Map<string, string> = new Map()
) {
  const cached = slugs.get(args.function);
  if (cached) {
    try {
      return await invokeSync(client, cached, args.input);
    } catch (error) {
      if (!(error instanceof B4mApiError && error.status === 404)) throw error;
      slugs.delete(args.function);
    }
  }
  const id = await resolveFunctionId(client, args.function, slugs);
  return await invokeSync(client, id, args.input);
}

export function registerFunctionTools(server: McpServer, client: B4mApiClient): void {
  const slugs = new Map<string, string>();
  const meta = (name: string) => FUNCTION_TOOL_META.find(t => t.name === name)!;
  // Result shapes match toResult and errorResult in tools.ts, which imports this module.
  const run = async (fn: () => Promise<Record<string, unknown>>, ref?: string): Promise<CallToolResult> => {
    try {
      const value = await fn();
      const text = JSON.stringify(value, null, 2);
      if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
        return { content: [{ type: 'text', text: OUTPUT_TOO_LARGE }], isError: true };
      }
      return { content: [{ type: 'text', text }], structuredContent: value };
    } catch (error) {
      const text = functionErrorMessage(error, client.baseURL, ref);
      const { stamp, problems } = errorBody(error);
      const meta = {
        ...(stamp && typeof stamp === 'object' ? { stamp } : {}),
        ...(Array.isArray(problems) && problems.length > 0 ? { problems } : {}),
      };
      return {
        content: [{ type: 'text', text }],
        isError: true,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      };
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
    args => run(() => callFunction(client, args, slugs), args.function)
  );
}
