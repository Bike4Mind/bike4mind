import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyScope,
  CompletionRunSchema,
  ConflictError,
  CreditHolderType,
  NotFoundError,
  RaiseCompletionRunBudgetRequestSchema,
  RUN_BUDGET_NOT_RAISED_ERROR_CODE,
  RUN_NOT_FOUND_ERROR_CODE,
} from '@bike4mind/common';

const { contracts, completionRunRepository, userRepository, resolveActiveOrg } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
  completionRunRepository: { findById: vi.fn(), raiseBudget: vi.fn() },
  userRepository: { findById: vi.fn() },
  resolveActiveOrg: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({ completionRunRepository, userRepository }));
vi.mock('@bike4mind/server-utils/utils/resolveActiveOrg', () => ({ resolveActiveOrg }));

import handler from '../budget';

const RUN_ID = '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80';
const CREATED_AT = new Date('2026-11-10T12:00:00.000Z');

const storedRun = (overrides: Record<string, unknown> = {}) => ({
  runId: RUN_ID,
  userId: 'user-1',
  ownerType: CreditHolderType.User,
  ownerId: 'user-1',
  budgetCredits: 500,
  committedCredits: 500,
  createdAt: CREATED_AT,
  ...overrides,
});

const call = async (budgetCredits: number, extra: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, {
    user: { id: 'user-1' },
    validatedParams: { runId: RUN_ID },
    validated: { budgetCredits },
    ...extra,
  });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('POST /api/v1/completion-runs/{runId}/budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completionRunRepository.findById.mockResolvedValue(storedRun());
  });

  it('is API-key callable with the same scopes as minting a run', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['raiseCompletionRunBudget', 'apiKeyOrJwt', [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE]],
    ]);
  });

  it('raises the budget of a run bound to the organization named in organization_id', async () => {
    const orgRun = storedRun({ ownerType: CreditHolderType.Organization, ownerId: 'org-2' });
    userRepository.findById.mockResolvedValueOnce({ id: 'user-1', isAdmin: false });
    resolveActiveOrg.mockResolvedValueOnce('org-2');
    completionRunRepository.findById.mockResolvedValue(orgRun);
    completionRunRepository.raiseBudget.mockResolvedValue({ kind: 'raised', run: { ...orgRun, budgetCredits: 800 } });

    const res = await call(800, { validated: { budgetCredits: 800, organization_id: 'org-2' } });

    expect(res._getStatusCode()).toBe(200);
    expect(completionRunRepository.raiseBudget).toHaveBeenCalledWith(RUN_ID, 800);
  });

  it('raises the budget and answers 200 with the run in the published shape', async () => {
    completionRunRepository.raiseBudget.mockResolvedValue({ kind: 'raised', run: storedRun({ budgetCredits: 800 }) });

    const res = await call(800);

    expect(completionRunRepository.raiseBudget).toHaveBeenCalledWith(RUN_ID, 800);
    expect(res._getStatusCode()).toBe(200);
    expect(CompletionRunSchema.parse(res._getJSONData())).toEqual({
      runId: RUN_ID,
      budgetCredits: 800,
      createdAt: CREATED_AT.toISOString(),
    });
  });

  it.each([
    ['a budget at or below the current one', { kind: 'not_higher', budgetCredits: 500 }],
    ['a run minted without a budget', { kind: 'unbudgeted' }],
  ])('refuses %s with 409 run_budget_not_raised', async (_case, outcome) => {
    completionRunRepository.raiseBudget.mockResolvedValue(outcome);

    const error: unknown = await call(400).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ additionalInfo: { errorCode: RUN_BUDGET_NOT_RAISED_ERROR_CODE } });
  });

  it('raises by run id and owner alone: a body naming a worker role or another root session adds nothing', async () => {
    completionRunRepository.findById.mockResolvedValue(storedRun({ rootSessionId: 'root-a' }));
    completionRunRepository.raiseBudget.mockResolvedValue({ kind: 'raised', run: storedRun({ budgetCredits: 800 }) });
    const validated = RaiseCompletionRunBudgetRequestSchema.parse({
      budgetCredits: 800,
      role: 'worker',
      rootSessionId: 'root-b',
      committedCredits: 0,
    });

    expect(validated).toEqual({ budgetCredits: 800 });
    await call(800, { validated });

    expect(completionRunRepository.raiseBudget.mock.calls).toEqual([[RUN_ID, 800]]);
  });

  it("refuses another account's run even when the request names that run's root session", async () => {
    completionRunRepository.findById.mockResolvedValue(
      storedRun({ userId: 'user-2', ownerId: 'user-2', rootSessionId: 'root-a' })
    );
    const validated = RaiseCompletionRunBudgetRequestSchema.parse({ budgetCredits: 800, rootSessionId: 'root-a' });

    await expect(call(800, { validated })).rejects.toBeInstanceOf(NotFoundError);
    expect(completionRunRepository.raiseBudget).not.toHaveBeenCalled();
  });

  it("never touches another account's run", async () => {
    completionRunRepository.findById.mockResolvedValue(storedRun({ userId: 'user-2', ownerId: 'user-2' }));

    const error: unknown = await call(800).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ additionalInfo: { errorCode: RUN_NOT_FOUND_ERROR_CODE } });
    expect(completionRunRepository.raiseBudget).not.toHaveBeenCalled();
  });

  it('refuses an org-billed run raised with the same user personal credential', async () => {
    completionRunRepository.findById.mockResolvedValue(
      storedRun({ ownerType: CreditHolderType.Organization, ownerId: 'org-1' })
    );

    await expect(call(800)).rejects.toBeInstanceOf(NotFoundError);
    expect(completionRunRepository.raiseBudget).not.toHaveBeenCalled();
  });
});
