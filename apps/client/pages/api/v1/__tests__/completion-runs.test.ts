import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, CompletionRunSchema, CreditHolderType } from '@bike4mind/common';

const { contracts, completionRunRepository } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
  completionRunRepository: { create: vi.fn() },
}));

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
vi.mock('@bike4mind/database', () => ({ completionRunRepository }));

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

  it('leaves rootSessionId off the response when none was sent', async () => {
    const res = await call({});

    expect(res._getJSONData()).not.toHaveProperty('rootSessionId');
  });
});
