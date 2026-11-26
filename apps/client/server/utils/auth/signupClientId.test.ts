import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindByClientId, mockWarn } = vi.hoisted(() => ({ mockFindByClientId: vi.fn(), mockWarn: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  oauthClientRepository: { findByClientId: (...a: unknown[]) => mockFindByClientId(...a) },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    warn = mockWarn;
  },
}));

import { resolveSignupClientId, samlRelayRedirectTo } from './signupClientId';

const CLIENT_ID = 'b4m_acme_0a1b2c3d';
const AUTHORIZE = `/oauth/authorize?client_id=${CLIENT_ID}&response_type=code`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSignupClientId', () => {
  it('returns the stored id of the active client named by an authorize redirect', async () => {
    mockFindByClientId.mockResolvedValue({ clientId: CLIENT_ID, isActive: true });

    await expect(resolveSignupClientId(AUTHORIZE)).resolves.toBe(CLIENT_ID);
    expect(mockFindByClientId).toHaveBeenCalledWith(CLIENT_ID);
  });

  it('returns null for an unknown client', async () => {
    mockFindByClientId.mockResolvedValue(null);

    await expect(resolveSignupClientId(AUTHORIZE)).resolves.toBeNull();
  });

  it('returns null for an inactive client', async () => {
    mockFindByClientId.mockResolvedValue({ clientId: CLIENT_ID, isActive: false });

    await expect(resolveSignupClientId(AUTHORIZE)).resolves.toBeNull();
  });

  it.each([
    ['a missing redirectTo', undefined],
    ['a non-authorize path', `/notebooks?client_id=${CLIENT_ID}`],
    ['an absolute URL', `https://evil.example/oauth/authorize?client_id=${CLIENT_ID}`],
    ['a malformed client id', '/oauth/authorize?client_id=%E0%A4%A'],
    ['a repeated client id', `${AUTHORIZE}&client_id=${CLIENT_ID}`],
  ])('returns null without a lookup for %s', async (_label, redirectTo) => {
    await expect(resolveSignupClientId(redirectTo)).resolves.toBeNull();
    expect(mockFindByClientId).not.toHaveBeenCalled();
  });

  it('returns null and logs when the lookup fails', async () => {
    mockFindByClientId.mockRejectedValue(new Error('db down'));

    await expect(resolveSignupClientId(AUTHORIZE)).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ clientId: CLIENT_ID }));
  });
});

describe('samlRelayRedirectTo', () => {
  const relayState = new URLSearchParams({ idp: 'idp-1', redirectTo: AUTHORIZE }).toString();

  it('reads redirectTo from a POST body RelayState', () => {
    expect(samlRelayRedirectTo({ method: 'POST', body: { RelayState: relayState } })).toBe(AUTHORIZE);
  });

  it('reads redirectTo from a GET query RelayState', () => {
    expect(samlRelayRedirectTo({ method: 'GET', query: { RelayState: relayState } })).toBe(AUTHORIZE);
  });

  it.each([
    ['no body', { method: 'POST' }],
    ['no RelayState', { method: 'POST', body: {} }],
    ['a repeated RelayState', { method: 'GET', query: { RelayState: [relayState, relayState] } }],
    ['a RelayState without redirectTo', { method: 'POST', body: { RelayState: 'idp=idp-1' } }],
  ])('returns undefined for %s', (_label, req) => {
    expect(samlRelayRedirectTo(req)).toBeUndefined();
  });
});
