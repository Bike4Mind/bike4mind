import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { z } from 'zod';
import { B4mApiError } from '@bike4mind/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { B4mApiClient } from './b4mApiClient';
import type { ApiClient } from '../auth/ApiClient';
import type { ConfigStore } from '../storage/ConfigStore';
import { registerTools } from './tools';
import { MAX_RESULT_BYTES } from './functionTools';

const BASE_URL = 'https://b4m.example.com';
const ID = 'a'.repeat(24);
const OTHER_ID = 'b'.repeat(24);

const summary = (id: string, slug: string) => ({
  id,
  slug,
  description: 'Beam deflection',
  trust_label: 'verified',
  pin_version: 7,
  pin_seq: 3,
  updated_at: '2026-11-01T00:00:00.000Z',
});

const detail = (id: string, slug: string) => ({
  ...summary(id, slug),
  input_schema: {
    type: 'object',
    properties: { span: { type: 'number', unit: 'm' } },
    required: ['span'],
    additionalProperties: false,
  },
  output_schema: {
    type: 'object',
    properties: { deflection: { type: 'number', unit: 'm' } },
    required: ['deflection'],
    additionalProperties: false,
  },
});

const stamp = { function_id: ID, slug: 'beam', pin_version: 7, code_hash: 'c'.repeat(64), surface: 'rest' };

const apiError = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new B4mApiError(status, body, new Headers(headers));

const mockClient = (overrides: Record<string, unknown>): B4mApiClient =>
  ({ baseURL: BASE_URL, ...overrides }) as unknown as B4mApiClient;

const collect = (client: B4mApiClient) => {
  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();
  const schemas = new Map<string, z.ZodRawShape>();
  const annotations = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool: (
      name: string,
      config: { inputSchema: z.ZodRawShape; annotations?: Record<string, unknown> },
      cb: (args: unknown) => Promise<CallToolResult>
    ) => {
      handlers.set(name, cb);
      schemas.set(name, config.inputSchema);
      annotations.set(name, config.annotations ?? {});
    },
    server: { getClientCapabilities: () => ({}) },
  } as unknown as McpServer;
  registerTools(server, client);
  const call = (name: string, args: unknown) => handlers.get(name)!(args);
  const parse = (name: string, args: unknown) => z.object(schemas.get(name)!).safeParse(args);
  return { handlers, annotations, call, parse };
};

const text = (result: CallToolResult) => (result.content[0] as { text: string }).text;

describe('function tools', () => {
  it('registers list_functions and call_function as read-only tools', () => {
    const { handlers, annotations, parse } = collect(mockClient({}));
    expect(handlers.has('list_functions')).toBe(true);
    expect(handlers.has('call_function')).toBe(true);
    expect(annotations.get('list_functions')).toEqual({ readOnlyHint: true });
    expect(annotations.get('call_function')).toEqual({ readOnlyHint: true });
    expect(parse('call_function', { function: 'beam', input: { span: 4 } }).success).toBe(true);
    expect(parse('call_function', { function: '', input: {} }).success).toBe(false);
    expect(parse('list_functions', { limit: 8 }).success).toBe(true);
    expect(parse('list_functions', { limit: 9 }).success).toBe(false);
  });

  it('lists each live function with its input and output schemas', async () => {
    const listFunctions = vi.fn().mockResolvedValue({ data: [summary(ID, 'beam')], next_cursor: 'next' });
    const getFunction = vi.fn().mockResolvedValue(detail(ID, 'beam'));
    const { call } = collect(mockClient({ listFunctions, getFunction }));

    const result = await call('list_functions', {});

    expect(result.isError).toBeUndefined();
    expect(listFunctions).toHaveBeenCalledWith(8, undefined);
    expect(getFunction).toHaveBeenCalledWith(ID);
    const listed = result.structuredContent as { functions: unknown[]; next_cursor: string };
    expect(listed.functions).toEqual([detail(ID, 'beam')]);

    await call('list_functions', { cursor: listed.next_cursor });
    expect(listFunctions).toHaveBeenLastCalledWith(8, 'next');
  });

  describe('a page of functions', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(24));
    const page = { data: ids.map((id, i) => summary(id, `fn-${i}`)), next_cursor: 'server-next' };

    it('reads the details one at a time', async () => {
      const listFunctions = vi.fn().mockResolvedValue(page);
      let running = 0;
      let busiest = 0;
      const getFunction = vi.fn(async (id: string) => {
        running++;
        busiest = Math.max(busiest, running);
        await new Promise(resolve => setTimeout(resolve, 1));
        running--;
        return detail(id, 'fn');
      });
      const { call } = collect(mockClient({ listFunctions, getFunction }));

      const result = await call('list_functions', { limit: 8 });

      expect(getFunction.mock.calls.map(c => c[0])).toEqual(ids);
      expect(busiest).toBe(1);
      expect((result.structuredContent as { functions: unknown[] }).functions).toHaveLength(8);
    });

    it('drops a function whose detail answers 404', async () => {
      const getFunction = vi.fn(async (id: string) => {
        if (id === ids[1]) throw apiError(404, { name: 'NotFoundError', error: 'Function not found' });
        return detail(id, 'fn');
      });
      const { call } = collect(mockClient({ listFunctions: vi.fn().mockResolvedValue(page), getFunction }));

      const result = await call('list_functions', {});

      expect(result.isError).toBeUndefined();
      const listed = (result.structuredContent as { functions: { id: string }[] }).functions;
      expect(listed.map(fn => fn.id)).toEqual(ids.filter(id => id !== ids[1]));
    });

    it('ends on a 429 with what was read and a cursor that resumes at the next function', async () => {
      const listFunctions = vi.fn().mockResolvedValue(page);
      let reads = 0;
      const getFunction = vi.fn(async (id: string) => {
        if (++reads === 3) throw apiError(429, { error: 'Too many requests' });
        return detail(id, 'fn');
      });
      const { call } = collect(mockClient({ listFunctions, getFunction }));

      const first = await call('list_functions', {});
      const firstPage = first.structuredContent as { functions: { id: string }[]; next_cursor: string };
      expect(first.isError).toBeUndefined();
      expect(firstPage.functions.map(fn => fn.id)).toEqual([ids[0], ids[1]]);

      const second = await call('list_functions', { cursor: firstPage.next_cursor });
      const secondPage = second.structuredContent as { functions: { id: string }[]; next_cursor: string };
      expect(listFunctions).toHaveBeenLastCalledWith(8, undefined);
      expect(secondPage.functions[0].id).toBe(ids[2]);
      expect(secondPage.functions.map(fn => fn.id)).toEqual(ids.slice(2));

      await call('list_functions', { cursor: secondPage.next_cursor });
      expect(listFunctions).toHaveBeenLastCalledWith(8, 'server-next');
    });

    it('resumes at the function that met the rate limit after an earlier one was dropped on a 404', async () => {
      let gone = false;
      const listFunctions = vi.fn(async () => ({
        data: page.data.filter(fn => !(gone && fn.id === ids[1])),
        next_cursor: null,
      }));
      let reads = 0;
      const getFunction = vi.fn(async (id: string) => {
        reads++;
        if (id === ids[1]) {
          gone = true;
          throw apiError(404, { name: 'NotFoundError', error: 'Function not found' });
        }
        if (reads === 3) throw apiError(429, { error: 'Too many requests' });
        return detail(id, 'fn');
      });
      const { call } = collect(mockClient({ listFunctions, getFunction }));

      const first = await call('list_functions', {});
      const firstPage = first.structuredContent as { functions: { id: string }[]; next_cursor: string };
      expect(firstPage.functions.map(fn => fn.id)).toEqual([ids[0]]);

      const second = await call('list_functions', { cursor: firstPage.next_cursor });
      const secondPage = second.structuredContent as { functions: { id: string }[] };
      expect(secondPage.functions.map(fn => fn.id)).toEqual(ids.slice(2));
    });

    it('reports the rate limit when it hits before any function is read', async () => {
      const getFunction = vi
        .fn()
        .mockRejectedValue(apiError(429, { error: 'Too many requests' }, { 'retry-after': '9' }));
      const { call } = collect(mockClient({ listFunctions: vi.fn().mockResolvedValue(page), getFunction }));

      const result = await call('list_functions', {});

      expect(result.isError).toBe(true);
      expect(text(result)).toBe('Too many function requests for this account. Retry after 9s.');
    });
  });

  it('passes the page size through', async () => {
    const listFunctions = vi.fn().mockResolvedValue({ data: [], next_cursor: null });
    const { call } = collect(mockClient({ listFunctions, getFunction: vi.fn() }));
    await call('list_functions', { limit: 5 });
    expect(listFunctions).toHaveBeenCalledWith(5, undefined);
  });

  describe('a cursor the CLI did not make', () => {
    const REFUSAL = 'That cursor did not come from list_functions. Call list_functions again without a cursor.';
    const issued = async () => {
      const listFunctions = vi.fn().mockResolvedValue({ data: [summary(ID, 'beam')], next_cursor: 'server-next' });
      const getFunction = vi.fn().mockResolvedValue(detail(ID, 'beam'));
      const { call } = collect(mockClient({ listFunctions, getFunction }));
      const cursor = ((await call('list_functions', {})).structuredContent as { next_cursor: string }).next_cursor;
      listFunctions.mockClear();
      return { call, listFunctions, cursor };
    };
    const edit = (cursor: string, change: (payload: Record<string, unknown>) => void) => {
      const [payload, mac] = cursor.split('.');
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
      change(parsed);
      return `${Buffer.from(JSON.stringify(parsed)).toString('base64url')}.${mac}`;
    };

    it('is refused with a fixed message and no list request: a server cursor', async () => {
      const { call, listFunctions } = await issued();
      const result = await call('list_functions', { cursor: 'server-next' });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(REFUSAL);
      expect(listFunctions).not.toHaveBeenCalled();
    });

    it('is refused: a cursor with its contents edited', async () => {
      const { call, listFunctions, cursor } = await issued();
      const result = await call('list_functions', {
        cursor: edit(cursor, payload => {
          payload.c = 'another-server-cursor';
        }),
      });
      expect(text(result)).toBe(REFUSAL);
      expect(listFunctions).not.toHaveBeenCalled();
    });

    it('is refused: a cursor without its signature', async () => {
      const { call, listFunctions, cursor } = await issued();
      const result = await call('list_functions', { cursor: cursor.split('.')[0] });
      expect(text(result)).toBe(REFUSAL);
      expect(listFunctions).not.toHaveBeenCalled();
    });

    it('is accepted when the CLI made it', async () => {
      const { call, listFunctions, cursor } = await issued();
      const result = await call('list_functions', { cursor });
      expect(result.isError).toBeUndefined();
      expect(listFunctions).toHaveBeenCalledWith(8, 'server-next');
    });
  });

  it('calls a function by id with its inputs and returns the output and stamp', async () => {
    const listFunctions = vi.fn();
    const invokeFunction = vi.fn().mockResolvedValue({ output: { deflection: 0.002 }, stamp });
    const { call } = collect(mockClient({ listFunctions, invokeFunction }));

    const result = await call('call_function', { function: ID, input: { span: 4 } });

    expect(listFunctions).not.toHaveBeenCalled();
    expect(invokeFunction).toHaveBeenCalledWith(ID, { span: 4 });
    expect(result.structuredContent).toEqual({ output: { deflection: 0.002 }, stamp });
    expect(JSON.parse(text(result))).toEqual({ output: { deflection: 0.002 }, stamp });
  });

  it('resolves a slug to its id across pages before calling', async () => {
    const listFunctions = vi
      .fn()
      .mockResolvedValueOnce({ data: [summary(OTHER_ID, 'other')], next_cursor: 'p2' })
      .mockResolvedValueOnce({ data: [summary(ID, 'beam')], next_cursor: null });
    const invokeFunction = vi.fn().mockResolvedValue({ output: { deflection: 0.002 }, stamp });
    const { call } = collect(mockClient({ listFunctions, invokeFunction }));

    await call('call_function', { function: 'beam', input: { span: 4 } });

    expect(listFunctions).toHaveBeenNthCalledWith(2, 100, 'p2');
    expect(invokeFunction).toHaveBeenCalledWith(ID, { span: 4 });
  });

  it('matches a slug exactly, not by its prefix', async () => {
    const listFunctions = vi.fn().mockResolvedValue({
      data: [summary(OTHER_ID, 'beam-long'), summary(ID, 'beam')],
      next_cursor: null,
    });
    const invokeFunction = vi.fn().mockResolvedValue({ output: {}, stamp });
    const { call } = collect(mockClient({ listFunctions, invokeFunction }));

    await call('call_function', { function: 'beam', input: {} });

    expect(invokeFunction).toHaveBeenCalledWith(ID, {});
  });

  it('stops paging for a slug when next_cursor is null', async () => {
    const listFunctions = vi.fn().mockResolvedValue({ data: [summary(ID, 'beam')], next_cursor: null });
    const { call } = collect(mockClient({ listFunctions, invokeFunction: vi.fn() }));

    const result = await call('call_function', { function: 'nope', input: {} });

    expect(result.isError).toBe(true);
    expect(listFunctions).toHaveBeenCalledTimes(1);
  });

  it('remembers a resolved slug, so the second call makes no list request', async () => {
    const listFunctions = vi.fn().mockResolvedValue({ data: [summary(ID, 'beam')], next_cursor: null });
    const invokeFunction = vi.fn().mockResolvedValue({ output: {}, stamp });
    const { call } = collect(mockClient({ listFunctions, invokeFunction }));

    await call('call_function', { function: 'beam', input: { span: 4 } });
    await call('call_function', { function: 'beam', input: { span: 5 } });

    expect(listFunctions).toHaveBeenCalledTimes(1);
    expect(invokeFunction).toHaveBeenNthCalledWith(2, ID, { span: 5 });
  });

  it('drops a remembered id that answers 404 and resolves the slug once more', async () => {
    const listFunctions = vi
      .fn()
      .mockResolvedValueOnce({ data: [summary(ID, 'beam')], next_cursor: null })
      .mockResolvedValueOnce({ data: [summary(OTHER_ID, 'beam')], next_cursor: null });
    const invokeFunction = vi
      .fn()
      .mockResolvedValueOnce({ output: {}, stamp })
      .mockRejectedValueOnce(apiError(404, { name: 'NotFoundError', error: 'Function not found' }))
      .mockResolvedValue({ output: { again: true }, stamp });
    const { call } = collect(mockClient({ listFunctions, invokeFunction }));

    await call('call_function', { function: 'beam', input: {} });
    const result = await call('call_function', { function: 'beam', input: {} });

    expect(listFunctions).toHaveBeenCalledTimes(2);
    expect(invokeFunction).toHaveBeenNthCalledWith(3, OTHER_ID, {});
    expect(result.structuredContent).toEqual({ output: { again: true }, stamp });
  });

  it('forgets a remembered id that is gone, so the next call does not try it again', async () => {
    const listFunctions = vi
      .fn()
      .mockResolvedValueOnce({ data: [summary(ID, 'beam')], next_cursor: null })
      .mockResolvedValueOnce({ data: [], next_cursor: null })
      .mockResolvedValueOnce({ data: [summary(OTHER_ID, 'beam')], next_cursor: null });
    let live = true;
    const invokeFunction = vi.fn(async (id: string) => {
      if (id === ID && !live) throw apiError(404, { name: 'NotFoundError', error: 'Function not found' });
      return { output: {}, stamp };
    });
    const { call } = collect(mockClient({ listFunctions, invokeFunction }));

    await call('call_function', { function: 'beam', input: {} });
    live = false;
    expect((await call('call_function', { function: 'beam', input: {} })).isError).toBe(true);
    const result = await call('call_function', { function: 'beam', input: {} });

    expect(result.isError).toBeUndefined();
    expect(invokeFunction.mock.calls.map(c => c[0])).toEqual([ID, ID, OTHER_ID]);
  });

  describe('a result over the output cap', () => {
    const resultOfSize = (bytes: number) => {
      const shell = JSON.stringify({ output: { data: '' }, stamp }, null, 2).length;
      return { output: { data: 'x'.repeat(bytes - shell) }, stamp };
    };

    it('is returned whole at the cap', async () => {
      const invokeFunction = vi.fn().mockResolvedValue(resultOfSize(MAX_RESULT_BYTES));
      const result = await collect(mockClient({ invokeFunction })).call('call_function', { function: ID, input: {} });

      expect(result.isError).toBeUndefined();
      expect(text(result)).toHaveLength(MAX_RESULT_BYTES);
    });

    it('is refused with output_too_large one byte over, and neither field carries the data', async () => {
      const invokeFunction = vi.fn().mockResolvedValue(resultOfSize(MAX_RESULT_BYTES + 1));
      const result = await collect(mockClient({ invokeFunction })).call('call_function', { function: ID, input: {} });

      expect(result).toEqual({
        content: [{ type: 'text', text: expect.stringMatching(/^output_too_large: .*2 MiB/) }],
        isError: true,
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
    });
  });

  it('names an unknown slug and points at list_functions', async () => {
    const listFunctions = vi.fn().mockResolvedValue({ data: [summary(ID, 'beam')], next_cursor: null });
    const invokeFunction = vi.fn();
    const { call } = collect(mockClient({ listFunctions, invokeFunction }));

    const result = await call('call_function', { function: 'nope', input: {} });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'No live function has the slug "nope". Call list_functions for the functions this key can call.'
    );
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  describe('refusals', () => {
    const refusal = async (error: unknown) => {
      const invokeFunction = vi.fn().mockRejectedValue(error);
      const result = await collect(mockClient({ invokeFunction })).call('call_function', { function: ID, input: {} });
      expect(result.isError).toBe(true);
      return text(result);
    };

    it('403 for a missing scope names the scope and how to get a key that holds it', async () => {
      expect(
        await refusal(
          apiError(403, { error: 'Insufficient API key permissions', required_scopes: ['functions:invoke'] })
        )
      ).toBe(
        'This API key does not hold functions:invoke. Create a key with the Functions access level in the API tab of your Bike4Mind profile and set it as B4M_API_KEY.'
      );
    });

    it('403 with functions turned off says who can turn them on', async () => {
      expect(await refusal(apiError(403, { error: 'Callable functions are turned off for this account.' }))).toBe(
        'Callable functions are turned off for this account. Ask an admin to turn on callable functions for this account and its organizations.'
      );
    });

    it('404 names the function and points at list_functions', async () => {
      expect(await refusal(apiError(404, { name: 'NotFoundError', error: 'Function not found' }))).toBe(
        `No live function "${ID}" belongs to this key's owner. Call list_functions for the functions this key can call. A draft or turned-off function must be promoted in Bike4Mind first.`
      );
    });

    it('404 without the error envelope reads as a server without these routes', async () => {
      expect(await refusal(apiError(404, 'Not Found'))).toMatch(/does not have this API route/);
    });

    it('413 asks for a smaller input', async () => {
      expect(await refusal(apiError(413, { error: 'The input is larger than a call accepts.' }))).toBe(
        'The input is larger than a call accepts. Send a smaller input.'
      );
    });

    it('422 names each field that does not fit', async () => {
      const body = {
        error: 'Input span must be a number.',
        problems: [
          { path: 'span', message: 'must be a number' },
          { path: 'load', message: 'is required' },
        ],
      };
      expect(await refusal(apiError(422, body))).toBe(
        'Input span must be a number. Fix: span must be a number; load is required. Read the input_schema from list_functions and call again.'
      );
    });

    it('422 carries the problems list in _meta, as the REST body does', async () => {
      const problems = [
        { path: 'span', message: 'must be a number' },
        { path: 'load', message: 'is required' },
      ];
      const invokeFunction = vi
        .fn()
        .mockRejectedValue(apiError(422, { error: 'Input span must be a number.', problems }));
      const result = await collect(mockClient({ invokeFunction })).call('call_function', { function: ID, input: {} });
      expect(result.isError).toBe(true);
      expect(result._meta).toEqual({ problems });
    });

    it('429 says when to retry', async () => {
      expect(await refusal(apiError(429, { error: 'Too many requests' }, { 'retry-after': '12' }))).toBe(
        'Too many function requests for this account. Retry after 12s.'
      );
    });

    it('502 names the outcome', async () => {
      expect(
        await refusal(apiError(502, { error: 'The function raised an error (ValueError).', outcome: 'error' }))
      ).toBe(
        "The function raised an error (ValueError). (outcome: error) The inputs fit; check the function's code in Bike4Mind or call it with other inputs."
      );
    });

    it('503 with no runtime gives the server text and says to retry soon', async () => {
      expect(await refusal(apiError(503, { error: 'No function runtime is available.' }))).toBe(
        'No function runtime is available. Try again in a minute; if it keeps happening, ask an admin.'
      );
    });

    it('503 when the runtime did not answer gives the server text and says to retry soon', async () => {
      expect(await refusal(apiError(503, { error: 'The function runtime did not answer. Try again later.' }))).toBe(
        'The function runtime did not answer. Try again later. Try again in a minute; if it keeps happening, ask an admin.'
      );
    });

    it('504 request_timeout gives the server text, says the call was stopped, and what to try', async () => {
      expect(
        await refusal(apiError(504, { error: 'The call ran past its time limit.', errorCode: 'request_timeout' }))
      ).toBe(
        'The call ran past its time limit. It was stopped. Try smaller inputs, or run the function in the Bike4Mind app.'
      );
    });

    it('an error result carries the stamp the server sent in _meta', async () => {
      const body = { error: 'The call ran past its time limit.', errorCode: 'request_timeout', stamp };
      const invokeFunction = vi.fn().mockRejectedValue(apiError(504, body));
      const result = await collect(mockClient({ invokeFunction })).call('call_function', { function: ID, input: {} });
      expect(result.isError).toBe(true);
      expect(result._meta).toEqual({ stamp });
      const unstamped = vi.fn().mockRejectedValue(apiError(503, { error: 'No function runtime is available.' }));
      expect(
        (await collect(mockClient({ invokeFunction: unstamped })).call('call_function', { function: ID, input: {} }))
          ._meta
      ).toBeUndefined();
    });

    it('a redirect says the server redirected, that these tools do not follow, and to check B4M_API_URL', async () => {
      expect(await refusal(apiError(307, ''))).toBe(
        `The Bike4Mind server at ${BASE_URL} redirected the request, and these tools do not follow redirects. Check that B4M_API_URL points at the server itself.`
      );
    });

    it('a refusal while listing reads the same way', async () => {
      const listFunctions = vi.fn().mockRejectedValue(apiError(403, { required_scopes: ['functions:invoke'] }));
      const result = await collect(mockClient({ listFunctions })).call('list_functions', {});
      expect(text(result)).toMatch(/^This API key does not hold functions:invoke\./);
    });
  });

  describe('the API key', () => {
    it('goes only to the configured host, in the x-api-key header', async () => {
      const key = ['test', 'key', 'value'].join('-');
      const api = new B4mApiClient(BASE_URL, {} as ConfigStore, key);
      const seen: { url: string; key: unknown; authorization: unknown; body: unknown }[] = [];
      const http = (api as unknown as { client: ApiClient }).client.getAxiosInstance();
      http.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
        const url = axios.getUri(config);
        const requestBody: unknown = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        seen.push({
          url,
          key: config.headers.get('x-api-key'),
          authorization: config.headers.get('authorization'),
          body: requestBody,
        });
        const body = url.includes('/invoke')
          ? { output: { deflection: 0.002 }, stamp }
          : url.includes(`/functions/${ID}`)
            ? { data: detail(ID, 'beam') }
            : { data: [summary(ID, 'beam')], next_cursor: null };
        const headers = { 'content-type': 'application/json' };
        return { data: JSON.stringify(body), status: 200, statusText: 'OK', headers, config };
      };
      const { call } = collect(api);

      expect((await call('list_functions', {})).isError).toBeUndefined();
      expect((await call('call_function', { function: 'beam', input: { span: 4 } })).structuredContent).toEqual({
        output: { deflection: 0.002 },
        stamp,
      });

      expect(seen.map(s => new URL(s.url).pathname)).toEqual([
        '/api/v1/functions',
        `/api/v1/functions/${ID}`,
        '/api/v1/functions',
        `/api/v1/functions/${ID}/invoke`,
      ]);
      for (const request of seen) {
        expect(new URL(request.url).origin).toBe(BASE_URL);
        expect(request.key).toBe(key);
        expect(request.authorization).toBeFalsy();
        expect(request.url).not.toContain(key);
      }
      expect(seen[3].body).toEqual({ input: { span: 4 } });
    });

    it('is not sent on to another host when the configured host redirects', async () => {
      const key = ['test', 'key', 'value'].join('-');
      const elsewhere: unknown[] = [];
      const target = createServer((req, res) => {
        elsewhere.push(req.headers['x-api-key']);
        res.end('{}');
      });
      await new Promise<void>(resolve => target.listen(0, resolve));
      const targetPort = (target.address() as AddressInfo).port;
      const home: unknown[] = [];
      const origin = createServer((req, res) => {
        home.push(req.headers['x-api-key']);
        res.writeHead(307, { location: `http://localhost:${targetPort}${req.url}` });
        res.end();
      });
      await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));

      try {
        const api = new B4mApiClient(
          `http://127.0.0.1:${(origin.address() as AddressInfo).port}`,
          {} as ConfigStore,
          key
        );
        (api as unknown as { client: ApiClient }).client.getAxiosInstance().defaults.proxy = false;
        const { call } = collect(api);

        const listed = await call('list_functions', {});
        const called = await call('call_function', { function: ID, input: { span: 4 } });

        expect(listed.isError).toBe(true);
        expect(called.isError).toBe(true);
        expect(text(listed)).toMatch(/redirected the request.*do not follow redirects.*B4M_API_URL/);
        expect(text(called)).toMatch(/redirected the request.*do not follow redirects.*B4M_API_URL/);
        expect(home).toEqual([key, key]);
        expect(elsewhere).toEqual([]);
      } finally {
        origin.close();
        target.close();
      }
    });

    it('is not sent on to another host when a function detail read is redirected', async () => {
      const key = ['test', 'key', 'value'].join('-');
      const elsewhere: unknown[] = [];
      const target = createServer((req, res) => {
        elsewhere.push(req.headers['x-api-key']);
        res.end('{}');
      });
      await new Promise<void>(resolve => target.listen(0, resolve));
      const targetPort = (target.address() as AddressInfo).port;
      const detailKeys: unknown[] = [];
      const origin = createServer((req, res) => {
        if (req.url?.startsWith(`/api/v1/functions/${ID}`)) {
          detailKeys.push(req.headers['x-api-key']);
          res.writeHead(307, { location: `http://localhost:${targetPort}${req.url}` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [summary(ID, 'beam')], next_cursor: null }));
      });
      await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));

      try {
        const api = new B4mApiClient(
          `http://127.0.0.1:${(origin.address() as AddressInfo).port}`,
          {} as ConfigStore,
          key
        );
        (api as unknown as { client: ApiClient }).client.getAxiosInstance().defaults.proxy = false;

        const listed = await collect(api).call('list_functions', {});

        expect(listed.isError).toBe(true);
        expect(text(listed)).toMatch(/redirected the request/);
        expect(detailKeys).toEqual([key]);
        expect(elsewhere).toEqual([]);
      } finally {
        origin.close();
        target.close();
      }
    });
  });
});
