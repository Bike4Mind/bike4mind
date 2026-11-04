import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteMcpOAuthDiscovery } from '@bike4mind/mcp/remote';

const h = vi.hoisted(() => ({
  settings: '' as string,
  rows: [] as Array<Record<string, unknown>>,
  register: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  mcpOAuthClientRegistrationRepository: {
    findByIssuerAndRedirect: vi.fn(async () => h.rows[0] ?? null),
    upsert: h.upsert,
  },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: async () => ({}),
  getSettingsValue: () => h.settings,
}));
vi.mock('@bike4mind/mcp/remote', () => ({ registerRemoteMcpClient: h.register }));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (value?: string | null) => (value ? `enc:${value}` : null),
  decryptToken: (value?: string | null) => (value ? value.replace(/^enc:/, '') : null),
}));

import { loadConnectionClient, resolveOAuthClient } from './clientIdentity';

const discovery = (overrides: Partial<RemoteMcpOAuthDiscovery> = {}) =>
  ({
    issuer: 'https://auth.example.com',
    cimdSupported: false,
    registrationEndpoint: 'https://auth.example.com/register',
    ...overrides,
  }) as RemoteMcpOAuthDiscovery;

const resolve = (extra: Partial<Parameters<typeof resolveOAuthClient>[0]> = {}) =>
  resolveOAuthClient({
    connection: {},
    discovery: discovery(),
    redirectUri: 'https://app.example.com/integrations/mcp-oauth-callback',
    clientName: 'Bike4Mind',
    fetchFn: vi.fn(),
    ...extra,
  });

beforeEach(() => {
  h.settings = '';
  h.rows = [];
  h.register.mockReset().mockResolvedValue({ clientId: 'dcr-client', tokenEndpointAuthMethod: 'none' });
  h.upsert.mockReset().mockImplementation(async (row: Record<string, unknown>) => ({ ...row, id: 'reg-1' }));
  vi.stubEnv('APP_URL', 'https://app.example.com');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('resolveOAuthClient', () => {
  it('prefers the admin preset client over everything else', async () => {
    h.settings = JSON.stringify({ linear: { clientId: 'preset-id', clientSecret: 's3cret' } });
    const resolved = await resolve({
      connection: { presetId: 'linear' as never },
      discovery: discovery({ cimdSupported: true }),
      manual: { clientId: 'typed' },
    });
    expect(resolved).toMatchObject({
      mode: 'preregistered',
      client: { clientId: 'preset-id', clientSecret: 's3cret', tokenEndpointAuthMethod: 'client_secret_post' },
    });
    expect(h.register).not.toHaveBeenCalled();
  });

  it('uses a client the user typed, storing it encrypted', async () => {
    const resolved = await resolve({ manual: { clientId: 'typed', clientSecret: 'shh' } });
    expect(resolved).toMatchObject({ mode: 'manual', manualClientIdEnc: 'enc:typed', manualClientSecretEnc: 'enc:shh' });
  });

  it('uses the metadata-document client on a public https app when the server supports it', async () => {
    const resolved = await resolve({ discovery: discovery({ cimdSupported: true }) });
    expect(resolved).toMatchObject({
      mode: 'cimd',
      client: { clientId: 'https://app.example.com/.well-known/oauth-client/mcp-client.json', tokenEndpointAuthMethod: 'none' },
    });
  });

  it('falls through to registration when the app URL is local, even if the server supports CIMD', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    const resolved = await resolve({ discovery: discovery({ cimdSupported: true }) });
    expect(resolved.mode).toBe('dcr');
  });

  it('registers once, then reuses the stored registration without another /register call', async () => {
    const first = await resolve();
    expect(first).toMatchObject({ mode: 'dcr', clientRegistrationId: 'reg-1' });
    expect(h.register).toHaveBeenCalledTimes(1);

    h.rows = [{ id: 'reg-1', clientId: 'dcr-client', clientSecretEnc: 'enc:abc', tokenEndpointAuthMethod: 'client_secret_post' }];
    const second = await resolve();
    expect(second).toMatchObject({ clientRegistrationId: 'reg-1', client: { clientId: 'dcr-client', clientSecret: 'abc' } });
    expect(h.register).toHaveBeenCalledTimes(1);
  });

  it('asks for a client id when nothing else is available', async () => {
    await expect(resolve({ discovery: discovery({ registrationEndpoint: undefined }) })).rejects.toMatchObject({
      additionalInfo: { code: 'client_required' },
    });
  });

  it('logs a malformed preset setting instead of ignoring it silently', async () => {
    h.settings = '{not json';
    await resolve({ connection: { presetId: 'linear' as never } });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('customMcpPresetClients is unusable'));
  });
});

describe('loadConnectionClient', () => {
  it('rebuilds a manual client from its stored ciphertext', async () => {
    const client = await loadConnectionClient(
      { auth: { kind: 'oauth', oauth: { clientMode: 'manual', manualClientIdEnc: 'enc:id', manualClientSecretEnc: 'enc:sec', issuer: 'i' } } } as never,
      'https://app.example.com/cb'
    );
    expect(client).toMatchObject({ clientId: 'id', clientSecret: 'sec' });
  });

  it('is undefined when the registration has gone', async () => {
    const client = await loadConnectionClient(
      { auth: { kind: 'oauth', oauth: { clientMode: 'dcr', issuer: 'i' } } } as never,
      'https://app.example.com/cb'
    );
    expect(client).toBeUndefined();
  });
});
