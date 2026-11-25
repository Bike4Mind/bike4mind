import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyScope,
  CompletionRunUsageSchema,
  CreditHolderType,
  ForbiddenError,
  NotFoundError,
  RUN_NOT_FOUND_ERROR_CODE,
} from '@bike4mind/common';

const { contracts, completionRunRepository, creditTransactionRepository, userRepository, resolveActiveOrg } =
  vi.hoisted(() => ({
    contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
    completionRunRepository: { findById: vi.fn() },
    creditTransactionRepository: { completionRunSpend: vi.fn() },
    userRepository: { findById: vi.fn() },
    resolveActiveOrg: vi.fn(),
  }));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: (typeof contracts)[number]) => {
    contracts.push(contract);
    let handler: ((req: unknown, res: unknown) => unknown) | undefined;
    const chain = Object.assign(async (req: unknown, res: unknown) => handler?.(req, res), {
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handler = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({ completionRunRepository, creditTransactionRepository, userRepository }));
vi.mock('@bike4mind/server-utils/utils/resolveActiveOrg', () => ({ resolveActiveOrg }));

import handler from '../usage';

const RUN_ID = '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80';
const CREATED_AT = new Date('2026-11-10T12:00:00.000Z');
const ORG_KEY = {
  keyId: 'key-1',
  scopes: [ApiKeyScope.AI_CHAT],
  billingOwnerType: 'Organization',
  organizationId: 'org-1',
};

const SPEND = {
  creditsCharged: 70,
  requests: 2,
  inputTokens: 200,
  outputTokens: 20,
  cacheReadTokens: 2000,
  cacheWriteTokens: 100,
};

const BREAKDOWN = {
  settled: SPEND,
  byRole: [{ role: 'worker', ...SPEND }],
  byPurpose: [{ purpose: 'turn', ...SPEND }],
  byModel: [{ model: 'claude-sonnet-5-5', ...SPEND }],
  byAttempt: [{ role: 'worker', taskId: 'task-a', attemptId: 'a1', ...SPEND }],
  byAttemptTruncated: false,
};

const storedRun = (overrides: Record<string, unknown> = {}) => ({
  runId: RUN_ID,
  userId: 'user-1',
  ownerType: CreditHolderType.User,
  ownerId: 'user-1',
  rootSessionId: 'session-1',
  createdAt: CREATED_AT,
  ...overrides,
});

const call = async (extra: Record<string, unknown> = {}, runId = RUN_ID) => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'user-1' }, validatedParams: { runId }, validatedQuery: {}, ...extra });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const expectRunNotFound = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(NotFoundError);
  expect(error).toMatchObject({ additionalInfo: { errorCode: RUN_NOT_FOUND_ERROR_CODE } });
  expect(creditTransactionRepository.completionRunSpend).not.toHaveBeenCalled();
};

describe('GET /api/v1/completion-runs/{runId}/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completionRunRepository.findById.mockResolvedValue(storedRun());
    creditTransactionRepository.completionRunSpend.mockResolvedValue(BREAKDOWN);
  });

  it('is API-key callable with the same scopes as minting a run', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['getCompletionRunUsage', 'apiKeyOrJwt', [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE]],
    ]);
  });

  it("answers 200 with the run and its owner's settled spend, in the published shape", async () => {
    const res = await call();

    expect(creditTransactionRepository.completionRunSpend).toHaveBeenCalledWith(RUN_ID, {
      ownerId: 'user-1',
      ownerType: CreditHolderType.User,
    });
    expect(res._getStatusCode()).toBe(200);
    const body: unknown = res._getJSONData();
    expect(CompletionRunUsageSchema.parse(body)).toEqual({
      runId: RUN_ID,
      rootSessionId: 'session-1',
      createdAt: CREATED_AT.toISOString(),
      ...BREAKDOWN,
    });
  });

  it('looks an uppercase run id up by its stored lowercase form', async () => {
    await call({}, RUN_ID.toUpperCase());

    expect(completionRunRepository.findById).toHaveBeenCalledWith(RUN_ID);
  });

  it("reads an org-billed key's run from the organization's ledger", async () => {
    completionRunRepository.findById.mockResolvedValue(
      storedRun({ ownerType: CreditHolderType.Organization, ownerId: 'org-1' })
    );

    const res = await call({ apiKeyInfo: ORG_KEY });

    expect(res._getStatusCode()).toBe(200);
    expect(creditTransactionRepository.completionRunSpend).toHaveBeenCalledWith(RUN_ID, {
      ownerId: 'org-1',
      ownerType: CreditHolderType.Organization,
    });
  });

  it('finds a signed-in caller run bound to the organization named in the organization_id query', async () => {
    const jwtUser = { id: 'user-1', isAdmin: false };
    userRepository.findById.mockResolvedValueOnce(jwtUser);
    resolveActiveOrg.mockResolvedValueOnce('org-2');
    completionRunRepository.findById.mockResolvedValue(
      storedRun({ ownerType: CreditHolderType.Organization, ownerId: 'org-2' })
    );

    const res = await call({ validatedQuery: { organization_id: 'org-2' } });

    expect(res._getStatusCode()).toBe(200);
    expect(resolveActiveOrg).toHaveBeenCalledWith({ user: jwtUser }, 'org-2');
    expect(creditTransactionRepository.completionRunSpend).toHaveBeenCalledWith(RUN_ID, {
      ownerId: 'org-2',
      ownerType: CreditHolderType.Organization,
    });
  });

  it('refuses an organization_id query naming an organization the caller may not use, reading nothing', async () => {
    userRepository.findById.mockResolvedValueOnce({ id: 'user-1', isAdmin: false });
    resolveActiveOrg.mockRejectedValueOnce(new ForbiddenError('You are not a member of the selected organization.'));

    await expect(call({ validatedQuery: { organization_id: 'org-9' } })).rejects.toMatchObject({ statusCode: 403 });
    expect(completionRunRepository.findById).not.toHaveBeenCalled();
  });

  it('refuses an org-billed key whose organization_id query names another organization', async () => {
    await expect(call({ apiKeyInfo: ORG_KEY, validatedQuery: { organization_id: 'org-2' } })).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { errorCode: 'billing_organization_mismatch' },
    });
    expect(completionRunRepository.findById).not.toHaveBeenCalled();
  });

  it('reports a budgeted run against its budget, separating unsettled claims from settled spend', async () => {
    completionRunRepository.findById.mockResolvedValue(storedRun({ budgetCredits: 500, committedCredits: 190 }));

    const res = await call();

    const body = CompletionRunUsageSchema.parse(res._getJSONData());
    expect(body.budget).toEqual({
      budgetCredits: 500,
      committedCredits: 190,
      reservedCredits: 120,
      remainingCredits: 310,
    });
  });

  it('leaves budget off the response for a run minted without one', async () => {
    const res = await call();

    expect(res._getJSONData()).not.toHaveProperty('budget');
  });

  it('leaves rootSessionId off the response when the run has none', async () => {
    completionRunRepository.findById.mockResolvedValue(storedRun({ rootSessionId: undefined }));

    const res = await call();

    expect(res._getJSONData()).not.toHaveProperty('rootSessionId');
  });

  it('refuses a run that does not exist', async () => {
    completionRunRepository.findById.mockResolvedValue(null);

    await expectRunNotFound(call());
  });

  it('refuses a run another user minted', async () => {
    completionRunRepository.findById.mockResolvedValue(storedRun({ userId: 'user-2', ownerId: 'user-2' }));

    await expectRunNotFound(call());
  });

  it("refuses an org-billed run read with the same user's personal credential", async () => {
    completionRunRepository.findById.mockResolvedValue(
      storedRun({ ownerType: CreditHolderType.Organization, ownerId: 'org-1' })
    );

    await expectRunNotFound(call());
  });

  it("refuses a personal run read with the same user's org-billed key", async () => {
    await expectRunNotFound(call({ apiKeyInfo: ORG_KEY }));
  });

  it("refuses another organization's run", async () => {
    completionRunRepository.findById.mockResolvedValue(
      storedRun({ ownerType: CreditHolderType.Organization, ownerId: 'org-2' })
    );

    await expectRunNotFound(call({ apiKeyInfo: ORG_KEY }));
  });
});
