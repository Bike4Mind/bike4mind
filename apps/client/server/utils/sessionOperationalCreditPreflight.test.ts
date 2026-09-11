import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockFindUserById, mockFindOrgById, mockGetSettingsMap } = vi.hoisted(() => ({
  mockFindUserById: vi.fn(),
  mockFindOrgById: vi.fn(),
  mockGetSettingsMap: vi.fn(async () => ({}) as Record<string, unknown>),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  organizationRepository: { findById: mockFindOrgById },
  userRepository: { findById: mockFindUserById },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: mockGetSettingsMap,
}));

import {
  checkSessionOperationalCredits,
  assertSessionOperationalCredits,
  filterSessionIdsByOperationalCredits,
} from './sessionOperationalCreditPreflight';
import { getQuestErrorCode } from '@bike4mind/common';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

/** Both gates on - the only configuration in which recordOperationalUsage can debit. */
const billingOn = () => mockGetSettingsMap.mockResolvedValue({ billOperationalUsage: 'true', enforceCredits: 'true' });

const preflight = (overrides: Partial<Parameters<typeof checkSessionOperationalCredits>[0]> = {}) =>
  checkSessionOperationalCredits({ userId: USER_ID, operationCount: 1, operation: 'session tagging', ...overrides });

describe('checkSessionOperationalCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsMap.mockResolvedValue({});
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 1000 });
    mockFindOrgById.mockResolvedValue(null);
  });

  // The gap this gate closes is latent: operational billing defaults OFF, so a deployment that
  // records-but-never-bills must keep queueing this work. A pre-flight stricter than the
  // settlement would take a working feature away from every deploy that never pays for it.
  it('allows, and reads no billing state, when operational billing is off', async () => {
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 0 });

    await expect(preflight()).resolves.toEqual({ allowed: true });
    expect(mockFindUserById).not.toHaveBeenCalled();
  });

  it('allows when billOperationalUsage is on but enforceCredits is off', async () => {
    mockGetSettingsMap.mockResolvedValue({ billOperationalUsage: 'true', enforceCredits: 'false' });
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 0 });

    await expect(preflight()).resolves.toEqual({ allowed: true });
  });

  it('allows a funded holder when billing is on', async () => {
    billingOn();

    await expect(preflight()).resolves.toEqual({ allowed: true });
  });

  it('refuses a user whose personal balance cannot cover the batch', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 3 });

    const verdict = await preflight({ operationCount: 4 });

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('currently have 3 credits');
  });

  // The batch is what makes the fan-out paths dangerous: a 1-credit check would wave through an
  // unbounded spider run against an org holding a single credit.
  it('sizes the requirement by operationCount, not per request', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 4 });

    await expect(preflight({ operationCount: 4 })).resolves.toEqual({ allowed: true });
    await expect(preflight({ operationCount: 5 })).resolves.toMatchObject({ allowed: false });
  });

  it('refuses an org member over the per-member cap even when the org pool is flush', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 0, organizationId: ORG_ID });
    mockFindOrgById.mockResolvedValue({
      id: ORG_ID,
      currentCredits: 1_000_000,
      maxCreditsPerMember: 10,
      userDetails: [{ id: USER_ID, usedCredits: 10 }],
    });

    const verdict = await preflight();

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('member credit limit');
  });

  // The holder is the org, not the member: reading the member's own (zero) balance here would
  // refuse every org user on a deployment that bills the pool.
  it('checks the org pool, not the member balance, for an org user', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 0, organizationId: ORG_ID });
    mockFindOrgById.mockResolvedValue({ id: ORG_ID, currentCredits: 50, userDetails: [] });

    await expect(preflight()).resolves.toEqual({ allowed: true });
  });

  it('refuses when the org pool cannot cover the batch', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 999, organizationId: ORG_ID });
    mockFindOrgById.mockResolvedValue({ id: ORG_ID, currentCredits: 2, userDetails: [] });

    const verdict = await preflight({ operationCount: 3 });

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('organization does not have enough credits');
  });

  // Fails OPEN by design: a mongo blip must not turn "attach a notebook" or "tag this session"
  // into an error. The settlement is still guarded by the balance it debits against.
  it('allows when the billing store throws', async () => {
    billingOn();
    mockFindUserById.mockRejectedValue(new Error('mongo down'));

    await expect(preflight()).resolves.toEqual({ allowed: true });
  });

  it('allows when the owner no longer exists', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue(null);

    await expect(preflight()).resolves.toEqual({ allowed: true });
  });

  it('short-circuits a zero-operation request without reading settings', async () => {
    billingOn();

    await expect(preflight({ operationCount: 0 })).resolves.toEqual({ allowed: true });
    expect(mockGetSettingsMap).not.toHaveBeenCalled();
  });

  // A half-resolved pair would skip the cap and bill the member personally for org usage.
  it('allows when the org read fails, rather than falling back to the member balance', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 1000, organizationId: ORG_ID });
    mockFindOrgById.mockRejectedValue(new Error('mongo down'));

    await expect(preflight()).resolves.toEqual({ allowed: true });
  });
});

describe('assertSessionOperationalCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrgById.mockResolvedValue(null);
  });

  it('resolves when the holder can pay', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 10 });

    await expect(
      assertSessionOperationalCredits({ userId: USER_ID, operationCount: 1, operation: 'session tagging' })
    ).resolves.toBeUndefined();
  });

  // The 422 `insufficient_credits` classification is what a caller matches on; a plain Error
  // would render as a 500 and read as a bug rather than a billing state.
  it('throws a 422 tagged insufficient_credits when the holder cannot pay', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 0 });

    const error = await assertSessionOperationalCredits({
      userId: USER_ID,
      operationCount: 1,
      operation: 'session tagging',
    }).catch((err: unknown) => err);

    expect(getQuestErrorCode(error)).toBe('insufficient_credits');
    expect((error as { statusCode?: number }).statusCode).toBe(422);
  });
});

describe('filterSessionIdsByOperationalCredits', () => {
  const OTHER_USER_ID = 'user-2';

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrgById.mockResolvedValue(null);
  });

  const filter = (sessions: { id: string; userId: string }[], logger?: { warn: ReturnType<typeof vi.fn> }) =>
    filterSessionIdsByOperationalCredits(sessions as never, {
      operationsPerSession: 2,
      operation: 'session summarization',
      logger: logger as never,
    });

  it('passes every session through when operational billing is off', async () => {
    mockGetSettingsMap.mockResolvedValue({});

    const allowed = await filter([
      { id: 's1', userId: USER_ID },
      { id: 's2', userId: OTHER_USER_ID },
    ]);

    expect(allowed).toEqual(new Set(['s1', 's2']));
  });

  // A project holds sessions shared in from other users, and the Summarize handler bills the
  // session OWNER. Checking the requester instead would gate the wrong balance in both
  // directions: a broke requester blocking a funded owner's summary, and vice versa.
  it('checks each distinct owner once, sized to that owner\'s share of the batch', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 1000 });

    await filter([
      { id: 's1', userId: USER_ID },
      { id: 's2', userId: USER_ID },
      { id: 's3', userId: OTHER_USER_ID },
    ]);

    expect(mockFindUserById).toHaveBeenCalledTimes(2);
    expect(mockFindUserById).toHaveBeenCalledWith(USER_ID);
    expect(mockFindUserById).toHaveBeenCalledWith(OTHER_USER_ID);
  });

  it('drops only the refused owner\'s sessions, and logs why', async () => {
    billingOn();
    mockFindUserById.mockImplementation(async (id: string) =>
      id === USER_ID ? { id, currentCredits: 0 } : { id, currentCredits: 1000 }
    );
    const logger = { warn: vi.fn() };

    const allowed = await filter(
      [
        { id: 's1', userId: USER_ID },
        { id: 's2', userId: OTHER_USER_ID },
      ],
      logger
    );

    expect(allowed).toEqual(new Set(['s2']));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ ownerId: USER_ID, sessionCount: 1 });
  });

  // Two sessions at 2 operations each is 4 credits, so a 3-credit owner must be refused - the
  // per-session floor would have waved this through.
  it('multiplies the per-session operation count across the owner\'s sessions', async () => {
    billingOn();
    mockFindUserById.mockResolvedValue({ id: USER_ID, currentCredits: 3 });

    const allowed = await filter([
      { id: 's1', userId: USER_ID },
      { id: 's2', userId: USER_ID },
    ]);

    expect(allowed).toEqual(new Set());
  });

  it('passes through an ownerless session without a billing read', async () => {
    billingOn();

    const allowed = await filter([{ id: 's1', userId: '' }]);

    expect(allowed).toEqual(new Set(['s1']));
    expect(mockFindUserById).not.toHaveBeenCalled();
  });
});
