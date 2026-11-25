import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyScope,
  CompletionRunSchema,
  CreateCompletionRunRequestSchema,
  CreditHolderType,
  ForbiddenError,
} from '@bike4mind/common';

const { contracts, completionRunRepository, userRepository, resolveActiveOrg, adminSettingsRepository } = vi.hoisted(
  () => ({
    contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
    completionRunRepository: { create: vi.fn() },
    adminSettingsRepository: { getSettingsValue: vi.fn() },
    userRepository: { findById: vi.fn() },
    resolveActiveOrg: vi.fn(),
  })
);

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: (typeof contracts)[number]) => {
    contracts.push(contract);
    let handler: ((req: unknown, res: unknown) => unknown) | undefined;
    const chain = Object.assign(async (req: unknown, res: unknown) => handler?.(req, res), {
      post: (fn: (req: unknown, res: unknown) => unknown) => ((handler = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({ completionRunRepository, userRepository, adminSettingsRepository }));
vi.mock('@bike4mind/server-utils/utils/resolveActiveOrg', () => ({ resolveActiveOrg }));

import handler from '../completion-runs';

const CREATED_AT = new Date('2026-11-10T12:00:00.000Z');

const call = async (extra: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { user: { id: 'user-1' }, validated: {}, ...extra });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('POST /api/v1/completion-runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completionRunRepository.create.mockImplementation(async (input: Record<string, unknown>) => ({
      ...input,
      runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
      createdAt: CREATED_AT,
    }));
  });

  it('is API-key callable with the same scopes as completions', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['createCompletionRun', 'apiKeyOrJwt', [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE]],
    ]);
  });

  it('binds a JWT caller run to the user and answers 201 with the published shape', async () => {
    const res = await call({ validated: { rootSessionId: 'session-1' } });

    expect(completionRunRepository.create).toHaveBeenCalledWith({
      userId: 'user-1',
      ownerType: CreditHolderType.User,
      ownerId: 'user-1',
      apiKeyId: undefined,
      rootSessionId: 'session-1',
    });
    expect(res._getStatusCode()).toBe(201);
    const body: unknown = res._getJSONData();
    expect(CompletionRunSchema.parse(body)).toEqual({
      runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
      rootSessionId: 'session-1',
      createdAt: CREATED_AT.toISOString(),
    });
  });

  it('binds a personal API key run to the user and records the key', async () => {
    await call({ apiKeyInfo: { keyId: 'key-1', scopes: [ApiKeyScope.AI_CHAT] } });

    expect(completionRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: CreditHolderType.User, ownerId: 'user-1', apiKeyId: 'key-1' })
    );
  });

  it('binds an org-billed API key run to the organization it bills, keeping the acting user', async () => {
    await call({
      apiKeyInfo: {
        keyId: 'key-1',
        scopes: [ApiKeyScope.AI_CHAT],
        billingOwnerType: 'Organization',
        organizationId: 'org-1',
      },
    });

    expect(completionRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', ownerType: CreditHolderType.Organization, ownerId: 'org-1' })
    );
  });

  describe('organization_id', () => {
    const jwtUser = { id: 'user-1', isAdmin: false };
    const ORG_KEY = {
      keyId: 'key-1',
      scopes: [ApiKeyScope.AI_CHAT],
      billingOwnerType: 'Organization',
      organizationId: 'org-1',
    };

    it.each([
      ['omitted', {}],
      ['null', { organization_id: null }],
    ])('binds a signed-in caller run to the user when organization_id is %s', async (_label, validated) => {
      const res = await call({ validated });

      expect(res._getStatusCode()).toBe(201);
      expect(completionRunRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerType: CreditHolderType.User, ownerId: 'user-1' })
      );
      expect(resolveActiveOrg).not.toHaveBeenCalled();
    });

    it('binds the run to an organization the signed-in caller may use', async () => {
      userRepository.findById.mockResolvedValueOnce(jwtUser);
      resolveActiveOrg.mockResolvedValueOnce('org-2');

      const res = await call({ validated: { organization_id: 'org-2' } });

      expect(res._getStatusCode()).toBe(201);
      expect(resolveActiveOrg).toHaveBeenCalledWith({ user: jwtUser }, 'org-2');
      expect(completionRunRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', ownerType: CreditHolderType.Organization, ownerId: 'org-2' })
      );
    });

    it('refuses an organization the signed-in caller may not use, minting nothing', async () => {
      userRepository.findById.mockResolvedValueOnce(jwtUser);
      resolveActiveOrg.mockRejectedValueOnce(new ForbiddenError('You are not a member of the selected organization.'));

      await expect(call({ validated: { organization_id: 'org-9' } })).rejects.toMatchObject({ statusCode: 403 });
      expect(completionRunRepository.create).not.toHaveBeenCalled();
    });

    it.each([
      ['another organization', 'org-2'],
      ['null', null],
    ])('refuses an org-billed key that names %s, minting nothing', async (_label, organization_id) => {
      await expect(call({ apiKeyInfo: ORG_KEY, validated: { organization_id } })).rejects.toMatchObject({
        statusCode: 403,
        additionalInfo: { errorCode: 'billing_organization_mismatch' },
      });
      expect(completionRunRepository.create).not.toHaveBeenCalled();
      expect(resolveActiveOrg).not.toHaveBeenCalled();
    });

    it("binds an org-billed key run to its organization when organization_id names the key's", async () => {
      await call({ apiKeyInfo: ORG_KEY, validated: { organization_id: 'org-1' } });

      expect(completionRunRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerType: CreditHolderType.Organization, ownerId: 'org-1' })
      );
    });
  });

  describe('evaluation', () => {
    const evaluation = { version: 1, maxProviderUsd: 1, maxTokens: 5000, maxRequests: 3, modelIds: ['model-1'] };

    it('refuses an evaluation run for a user missing from the evaluationUserIds setting', async () => {
      adminSettingsRepository.getSettingsValue.mockResolvedValue('user-2, user-3');

      await expect(call({ validated: { evaluation } })).rejects.toMatchObject({
        additionalInfo: { errorCode: 'evaluation_not_enabled' },
      });
      expect(adminSettingsRepository.getSettingsValue).toHaveBeenCalledWith('evaluationUserIds');
      expect(completionRunRepository.create).not.toHaveBeenCalled();
    });

    it('mints an evaluation run once the setting lists the user, without a redeploy', async () => {
      adminSettingsRepository.getSettingsValue.mockResolvedValue('user-2, user-1');

      const res = await call({ validated: { evaluation } });

      expect(res._getStatusCode()).toBe(201);
      expect(completionRunRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ evaluation: expect.objectContaining({ limits: evaluation }) })
      );
    });
  });

  it('leaves rootSessionId off the response when none was sent', async () => {
    const res = await call({});

    expect(res._getJSONData()).not.toHaveProperty('rootSessionId');
  });

  it('mints a budgeted run and returns its budget', async () => {
    completionRunRepository.create.mockImplementation(async (input: Record<string, unknown>) => ({
      ...input,
      committedCredits: 0,
      runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
      createdAt: CREATED_AT,
    }));

    const res = await call({ validated: { budgetCredits: 5000 } });

    expect(completionRunRepository.create).toHaveBeenCalledWith(expect.objectContaining({ budgetCredits: 5000 }));
    expect(CompletionRunSchema.parse(res._getJSONData())).toEqual({
      runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
      budgetCredits: 5000,
      createdAt: CREATED_AT.toISOString(),
    });
  });

  it('accepts a trimmed organization_id or null, and rejects an empty one', () => {
    expect(CreateCompletionRunRequestSchema.parse({ organization_id: ' org-2 ' })).toEqual({
      organization_id: 'org-2',
    });
    expect(CreateCompletionRunRequestSchema.parse({ organization_id: null })).toEqual({ organization_id: null });
    expect(CreateCompletionRunRequestSchema.safeParse({ organization_id: ' ' }).success).toBe(false);
  });

  it('rejects a budget that is not a positive whole number of credits', () => {
    for (const budgetCredits of [0, -5, 12.5]) {
      expect(CreateCompletionRunRequestSchema.safeParse({ budgetCredits }).success).toBe(false);
    }
  });
});
