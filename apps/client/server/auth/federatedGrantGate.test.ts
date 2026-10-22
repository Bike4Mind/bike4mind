import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindGrant = vi.fn();
vi.mock('@bike4mind/database/auth', () => ({
  oauthGrantRepository: { findGrant: (...a: unknown[]) => mockFindGrant(...a) },
}));

import { checkFederatedGrant } from './federatedGrantGate';

const SCOPE = 'federated:admin-status';
const RELYING_PARTY = { clientType: 'relying-party' };

function gate(overrides: Partial<Parameters<typeof checkFederatedGrant>[0]> = {}) {
  return checkFederatedGrant({
    client: RELYING_PARTY,
    clientId: 'client-1',
    userId: 'user-1',
    scopes: [SCOPE],
    logger: { warn: vi.fn() },
    logTag: 'TEST',
    enforce: true,
    ...overrides,
  });
}

describe('checkFederatedGrant (enforced)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a grant that does not cover the requested scope, naming it', async () => {
    mockFindGrant.mockResolvedValue({ scopes: ['openid'] });
    const rejection = await gate();
    expect(rejection).toMatchObject({ status: 403, error: 'access_denied' });
    expect(rejection?.error_description).toContain(SCOPE);
    expect(mockFindGrant).toHaveBeenCalledWith('user-1', 'client-1');
  });

  it('allows a grant that covers every requested scope', async () => {
    mockFindGrant.mockResolvedValue({ scopes: ['openid', SCOPE] });
    expect(await gate()).toBeNull();
  });

  it('rejects when the user has no grant', async () => {
    mockFindGrant.mockResolvedValue(null);
    expect(await gate()).toMatchObject({ status: 403, error: 'access_denied' });
  });

  it('fails closed with 503 when the grant lookup throws', async () => {
    mockFindGrant.mockRejectedValue(new Error('db down'));
    expect(await gate()).toMatchObject({ status: 503, error: 'temporarily_unavailable' });
  });

  it.each([
    ['first-party', { clientType: 'first-party' }],
    ['legacy (no clientType)', {}],
  ])('exempts a %s client without looking up a grant', async (_label, client) => {
    expect(await gate({ client })).toBeNull();
    expect(mockFindGrant).not.toHaveBeenCalled();
  });
});
