import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { checkBatchSpendCap } from './createJob';

const settings = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn(async () => settings.current),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const logger = new Logger({ metadata: { test: 'checkBatchSpendCap' } });
const youngUser = { id: 'u1', createdAt: new Date(Date.now() - DAY_MS), isAdmin: false } as IUserDocument;

const makeDeps = (spentCredits: number) => {
  const onRefused = vi.fn(async () => undefined);
  const credits = {
    users: { findById: vi.fn(async () => youngUser) },
    newAccountSpendCap: {
      adminSettings: {},
      personalSpendSince: vi.fn(async () => [{ at: new Date(Date.now() - 60_000), credits: spentCredits }]),
      onRefused,
    },
  } as unknown as CreditHoldAdapters;
  return { deps: { credits, logger }, onRefused };
};

const user = { id: 'u1', organizationId: null };

beforeEach(() => {
  vi.clearAllMocks();
  settings.current = {
    enforceCredits: 'true',
    newAccountSpendCapDays: '7',
    newAccountHourlySpendCapCredits: '0',
    newAccountDailySpendCapCredits: '1000',
  };
});

describe('checkBatchSpendCap', () => {
  it("refuses with holdJobCredits' 402 when the batch total would take a young account over its cap", async () => {
    const { deps, onRefused } = makeDeps(400);
    const refusal = await checkBatchSpendCap({ enforceCredits: true, user, totalCredits: 700 }, deps);
    expect(refusal).toMatchObject({ ok: false, status: 402, code: 'insufficient_credits' });
    expect(refusal?.message).toMatch(/New accounts can spend up to 1,000 credits per day/);
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  it('allows a batch whose total fits under the cap', async () => {
    const { deps } = makeDeps(400);
    expect(await checkBatchSpendCap({ enforceCredits: true, user, totalCredits: 600 }, deps)).toBeNull();
  });

  it('does not cap an org-billed batch', async () => {
    const { deps } = makeDeps(400);
    const orgUser = { id: 'u1', organizationId: 'org1' };
    expect(await checkBatchSpendCap({ enforceCredits: true, user: orgUser, totalCredits: 5000 }, deps)).toBeNull();
  });

  it('caps a batch whose organizationId is an empty string, as holdCredits bills it to the user', async () => {
    const { deps } = makeDeps(400);
    const emptyOrg = { id: 'u1', organizationId: '' };
    expect(await checkBatchSpendCap({ enforceCredits: true, user: emptyOrg, totalCredits: 700 }, deps)).toMatchObject({
      code: 'insufficient_credits',
    });
  });

  it('returns null for a batch with no credits to cap', async () => {
    const { deps } = makeDeps(400);
    expect(await checkBatchSpendCap({ enforceCredits: true, user, totalCredits: 0 }, deps)).toBeNull();
  });

  it('returns null without refusing when the user no longer exists', async () => {
    const { deps, onRefused } = makeDeps(400);
    vi.mocked(deps.credits.users.findById).mockResolvedValueOnce(null);
    expect(await checkBatchSpendCap({ enforceCredits: true, user, totalCredits: 5000 }, deps)).toBeNull();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('skips the check when credits are not enforced', async () => {
    const { deps } = makeDeps(400);
    expect(await checkBatchSpendCap({ enforceCredits: false, user, totalCredits: 5000 }, deps)).toBeNull();
    expect(deps.credits.users.findById).not.toHaveBeenCalled();
  });
});
