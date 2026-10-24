import { ApiKeyStatus, CreditHolderType } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findKey, resolveOrg, runDecision } = vi.hoisted(() => ({
  findKey: vi.fn(),
  resolveOrg: vi.fn(),
  runDecision: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ userApiKeyRepository: { findByUserIdAndId: findKey } }));
vi.mock('@bike4mind/server-utils/utils/resolveActiveOrg', () => ({ resolveActiveOrg: resolveOrg }));
vi.mock('./runDecision', () => ({ runDecision }));

import { runDecisionTool } from './runDecisionTool';

const params = () => ({
  userId: 'user-1',
  user: { id: 'user-1', organizationId: 'home-org' } as never,
  logger: {} as never,
  source: 'web' as const,
  authOrigin: 'session' as const,
  request: { input: 'text', questions: [{ type: 'predicate' as const, name: 'urgent', instructions: 'Urgent?' }] },
});

beforeEach(() => {
  vi.resetAllMocks();
  resolveOrg.mockImplementation(async (_request, organizationId) => organizationId);
});

describe('runDecisionTool', () => {
  it('uses personal billing when no workspace is selected, even for a home-org member', async () => {
    await runDecisionTool(params());
    expect(runDecision).toHaveBeenCalledWith({
      caller: expect.objectContaining({ billingOrganizationId: null, apiKeyInfo: undefined }),
      body: params().request,
    });
    expect(findKey).not.toHaveBeenCalled();
  });

  it('validates and forwards the active workspace, rather than the home org', async () => {
    const input = { ...params(), organizationId: 'selected-org' };
    await runDecisionTool(input);
    expect(resolveOrg).toHaveBeenCalledWith({ user: input.user }, 'selected-org');
    expect(runDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({ billingOrganizationId: 'selected-org' }),
      })
    );
  });

  it('does not run or bill when active-workspace validation fails', async () => {
    resolveOrg.mockRejectedValue(new Error('not a member'));
    await expect(runDecisionTool({ ...params(), organizationId: 'other-org' })).rejects.toThrow('not a member');
    expect(runDecision).not.toHaveBeenCalled();
  });

  it.each([
    { billingOwnerType: CreditHolderType.User },
    { billingOwnerType: CreditHolderType.Organization, organizationId: 'key-org' },
  ])('restores the key scopes and payer from storage: $billingOwnerType', async billing => {
    findKey.mockResolvedValue({ status: ApiKeyStatus.ACTIVE, scopes: ['ai:chat'], ...billing });
    await runDecisionTool({ ...params(), authOrigin: 'apiKey', apiKeyId: 'key-1', organizationId: 'ignored-org' });
    expect(findKey).toHaveBeenCalledWith('user-1', 'key-1');
    expect(runDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({
          apiKeyId: 'key-1',
          apiKeyInfo: { keyId: 'key-1', scopes: ['ai:chat'], ...billing },
          billingOrganizationId: undefined,
        }),
      })
    );
    expect(resolveOrg).not.toHaveBeenCalled();
  });

  it.each([null, { status: ApiKeyStatus.DISABLED }, { status: ApiKeyStatus.ACTIVE, expiresAt: new Date(0) }])(
    'fails closed for a missing, disabled or expired key',
    async key => {
      findKey.mockResolvedValue(key);
      await expect(runDecisionTool({ ...params(), authOrigin: 'apiKey', apiKeyId: 'key-1' })).rejects.toThrow();
      expect(runDecision).not.toHaveBeenCalled();
    }
  );

  it('does not turn an API-key origin without a key id into a session caller', async () => {
    await expect(runDecisionTool({ ...params(), authOrigin: 'apiKey' })).rejects.toThrow('does not match');
    expect(runDecision).not.toHaveBeenCalled();
  });

  it('surfaces a key lookup failure without starting a decision', async () => {
    findKey.mockRejectedValue(new Error('database unavailable'));
    await expect(runDecisionTool({ ...params(), authOrigin: 'apiKey', apiKeyId: 'key-1' })).rejects.toThrow(
      'database unavailable'
    );
    expect(runDecision).not.toHaveBeenCalled();
  });
});
