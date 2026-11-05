import { describe, expect, it, vi } from 'vitest';
import {
  RemoteMcpAuthFailedError,
  RemoteMcpAuthRequiredError,
  RemoteMcpInvalidUrlError,
  RemoteMcpProtocolError,
  RemoteMcpSizeCapError,
  RemoteMcpSsrfBlockedError,
  RemoteMcpTimeoutError,
  RemoteMcpUpstreamError,
  RemoteMcpError,
  type RemoteMcpListToolsResult,
} from '@bike4mind/mcp/remote';
import {
  createInProcessRemoteMcpRunner,
  createLambdaRemoteMcpRunner,
  deserializeRemoteMcpError,
  serializeRemoteMcpError,
  type RemoteMcpRunPayload,
} from './remoteMcpRunner';

const payload: RemoteMcpRunPayload = {
  url: 'https://mcp.example.com/mcp',
  transport: 'auto',
  headers: { Authorization: 'Bearer secret-token' },
  action: 'listTools',
  network: { ownHosts: ['app.example.com'] },
};
const listed: RemoteMcpListToolsResult = { tools: [], dropped: [], detectedTransport: 'streamable-http' };
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

describe('RemoteMcpError codec', () => {
  it.each([
    new RemoteMcpInvalidUrlError('scheme', 'bad scheme'),
    new RemoteMcpSsrfBlockedError('blocked'),
    new RemoteMcpTimeoutError('slow'),
    new RemoteMcpAuthRequiredError({
      resourceMetadataUrl: 'https://auth.example.com/.well-known/x',
      scope: 'read',
      wwwAuthenticate: 'Bearer realm="x"',
    }),
    new RemoteMcpAuthFailedError('refused', 'write'),
    new RemoteMcpProtocolError('not mcp'),
    new RemoteMcpSizeCapError('too big'),
    new RemoteMcpUpstreamError(503),
  ])('round-trips $name', error => {
    const wire = JSON.parse(JSON.stringify(serializeRemoteMcpError(error)));
    const back = deserializeRemoteMcpError(wire);
    expect(back).toBeInstanceOf(error.constructor);
    expect(back.name).toBe(error.name);
    expect(back).toMatchObject({ ...error, message: error.message });
  });

  it('rejects an unknown code or a non-object', () => {
    expect(() => deserializeRemoteMcpError({ code: 'boom', message: 'x' })).toThrow();
    expect(() => deserializeRemoteMcpError(null)).toThrow();
    expect(() => deserializeRemoteMcpError('auth_required')).toThrow();
  });

  it('rejects an unknown or non-string invalid_url reason and defaults an absent one', () => {
    expect(() => deserializeRemoteMcpError({ code: 'invalid_url', message: 'x', reason: 'boom' })).toThrow(
      'Unknown RemoteMcpError reason'
    );
    expect(() => deserializeRemoteMcpError({ code: 'invalid_url', message: 'x', reason: 5 })).toThrow(
      'Unknown RemoteMcpError reason'
    );
    expect(deserializeRemoteMcpError({ code: 'invalid_url', message: 'x' })).toMatchObject({ reason: 'malformed' });
  });
});

describe('createInProcessRemoteMcpRunner', () => {
  it('lets network carry only the network options, never url, headers or limits', async () => {
    const configs: Record<string, unknown>[] = [];
    const client = { listTools: async () => listed };
    const runner = createInProcessRemoteMcpRunner(config => {
      configs.push(config as unknown as Record<string, unknown>);
      return client as never;
    });
    const hostile = {
      ownHosts: ['a.example.com'],
      allowHttp: true,
      url: 'https://evil.example.com',
      headers: { Authorization: 'evil' },
      limits: { maxBytes: 1 },
    } as unknown as RemoteMcpRunPayload['network'];
    await runner({ ...payload, network: hostile });
    expect(configs[0]).toMatchObject({ url: payload.url, headers: payload.headers, ownHosts: ['a.example.com'] });
    expect(configs[0].limits).toBeUndefined();
    expect(configs[0].allowHttp).toBe(true);
  });
});

describe('createLambdaRemoteMcpRunner', () => {
  it('sends the payload as JSON with RequestResponse and returns the run', async () => {
    const send = vi.fn(async () => ({ Payload: bytes({ ok: true, run: { action: 'listTools', result: listed } }) }));
    const run = await createLambdaRemoteMcpRunner('remote-fn', send)(payload);
    expect(run).toEqual({ action: 'listTools', result: listed });
    const input = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input;
    expect(input).toMatchObject({ FunctionName: 'remote-fn', InvocationType: 'RequestResponse' });
    expect(JSON.parse(Buffer.from(input.Payload as Uint8Array).toString())).toEqual(payload);
  });

  it('rethrows a typed failure as the same class with its challenge fields', async () => {
    const wire = serializeRemoteMcpError(
      new RemoteMcpAuthRequiredError({ resourceMetadataUrl: 'https://auth.example.com/m', scope: 'read' })
    );
    const send = async () => ({ Payload: bytes({ ok: false, error: wire }) });
    const error = await createLambdaRemoteMcpRunner('fn', send)(payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteMcpAuthRequiredError);
    expect(error).toMatchObject({
      code: 'auth_required',
      resourceMetadataUrl: 'https://auth.example.com/m',
      scope: 'read',
    });
  });

  it.each([
    [
      'a FunctionError',
      async () => ({
        FunctionError: 'Unhandled',
        Payload: bytes({ ok: true, run: { action: 'listTools', result: listed } }),
      }),
    ],
    ['unparsable JSON', async () => ({ Payload: bytes('LEAK-2 {not json') })],
    ['no payload', async () => ({ FunctionError: undefined, Payload: undefined })],
    ['a send failure', async () => Promise.reject(new Error('LEAK-3'))],
    ['an unknown error code', async () => ({ Payload: bytes({ ok: false, error: { code: 'LEAK-4', message: 'x' } }) })],
    [
      'a mismatched action',
      async () => ({ Payload: bytes({ ok: true, run: { action: 'callTool', result: { LEAK: 5 } } }) }),
    ],
  ])('throws a plain fixed-text Error on %s', async (_name, send) => {
    const error = await createLambdaRemoteMcpRunner('fn', send)(payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RemoteMcpError);
    expect((error as Error).message).toBe('Remote MCP handler invocation failed');
  });

  it('rejects a reply whose run action differs from the requested one', async () => {
    const send = async () => ({
      Payload: bytes({ ok: true, run: { action: 'callTool', result: { content: [] } } }),
    });
    await expect(createLambdaRemoteMcpRunner('fn', send)(payload)).rejects.toThrow(
      'Remote MCP handler invocation failed'
    );
  });

  it('keeps the invoke failure name as the cause, never its message', async () => {
    const send = async () => Promise.reject(Object.assign(new Error('LEAK-6'), { name: 'ThrottlingException' }));
    const error = (await createLambdaRemoteMcpRunner('fn', send)(payload).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('Remote MCP handler invocation failed');
    expect(error.cause).toBe('ThrottlingException');
  });

  it('records the FunctionError type as the cause', async () => {
    const send = async () => ({
      FunctionError: 'Unhandled',
      Payload: bytes({ ok: true, run: { action: 'listTools', result: listed } }),
    });
    const error = (await createLambdaRemoteMcpRunner('fn', send)(payload).catch((e: unknown) => e)) as Error;
    expect(error.cause).toBe('FunctionError: Unhandled');
  });
});
