import { describe, expect, it } from 'vitest';
import {
  deserializeRemoteMcpError,
  type RemoteMcpRunPayload,
} from '@bike4mind/server-utils/mcpConnections/remoteMcpRunner';
import { createHandler } from './remoteMcpCall';

const event: RemoteMcpRunPayload = {
  url: 'https://mcp.example.com/mcp',
  transport: 'auto',
  headers: {},
  action: 'listTools',
  network: { ownHosts: [] },
};
const run = { action: 'listTools', result: { tools: [], dropped: [], detectedTransport: 'streamable-http' } } as const;

describe('remoteMcpHandler', () => {
  it('returns the run for a valid event', async () => {
    await expect(createHandler(async () => run)(event)).resolves.toEqual({ ok: true, run });
  });

  it('returns a typed failure as a value with its challenge fields', async () => {
    const handler = createHandler(async () => {
      throw deserializeRemoteMcpError({
        code: 'auth_required',
        message: '',
        resourceMetadataUrl: 'https://auth.example.com/m',
        scope: 'read',
      });
    });
    await expect(handler(event)).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'auth_required',
        resourceMetadataUrl: 'https://auth.example.com/m',
        scope: 'read',
      }),
    });
  });

  it('rethrows anything that is not a RemoteMcpError', async () => {
    await expect(
      createHandler(async () => {
        throw new TypeError('boom');
      })(event)
    ).rejects.toThrow('boom');
    await expect(
      createHandler(async () => {
        throw deserializeRemoteMcpError({ code: 'timeout', message: 'slow' });
      })(event)
    ).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it.each([
    null,
    'x',
    {},
    { ...event, action: 'nope' },
    { ...event, url: 1 },
    { ...event, network: null },
    { ...event, headers: [] },
  ])('rejects a malformed event %#', async bad => {
    await expect(createHandler(async () => run)(bad)).rejects.toThrow('Invalid remote MCP payload');
  });
});
