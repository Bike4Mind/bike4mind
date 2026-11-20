// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: vi.fn(),
  getSpent: vi.fn(),
  resolvePoolBudget: vi.fn(),
  countPendingRiskReviews: vi.fn(),
  countHeld: vi.fn(),
  countDomainHolds: vi.fn(),
  summarizeWindow: vi.fn(),
  secret: 'configured-secret' as string | undefined,
  secretThrows: false,
}));

vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingNames: h.settings, findAll: h.settings },
  signupGrantBudgetRepository: { getSpent: h.getSpent },
  userRepository: { countPendingRiskReviews: h.countPendingRiskReviews },
  signupGrantReleaseRepository: { countHeld: h.countHeld },
  SignupDomainReviewModel: { countDocuments: h.countDomainHolds },
  paymentAttemptRepository: { summarizeWindow: h.summarizeWindow },
}));
vi.mock('@bike4mind/services', () => ({
  userService: {
    signupGrantBudgetDay: (now: Date) => now.toISOString().slice(0, 10),
    signupGrantBudgetKey: (pool: string, day: string) => `${pool}:${day}`,
    resolvePoolBudget: h.resolvePoolBudget,
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    get TURNSTILE_SECRET_KEY() {
      if (h.secretThrows) throw new Error('secret unavailable');
      return h.secret;
    },
  },
}));

import { getIncidentState } from '../incidentState';

const NOW = new Date('2026-11-02T15:30:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const window = (attempts: number) => ({
  attempts,
  succeeded: attempts - 1,
  failed: 1,
  radarBlocked: 1,
  elevatedRisk: 0,
  hostingNetwork: 0,
  distinctCards: attempts,
});

const storedSettings = (values: Record<string, unknown>) =>
  Object.entries(values).map(([settingName, settingValue]) => ({ settingName, settingValue }));

beforeEach(() => {
  vi.clearAllMocks();
  h.secret = 'configured-secret';
  h.secretThrows = false;
  h.settings.mockResolvedValue(
    storedSettings({
      turnstileEnabled: true,
      turnstileFailClosed: false,
      newAccountSpendCapDays: 7,
      paymentRiskAlertsEnabled: true,
      paymentRiskAutoRefundEnabled: false,
      paymentRiskLinkedAccountActions: true,
      paymentRiskCheckoutMaxBlockedAttempts: 3,
    })
  );
  h.resolvePoolBudget.mockImplementation(async (_settings: unknown, pool: string) =>
    pool === 'signup' ? { budget: 5000, missing: false } : { budget: 0, missing: true }
  );
  h.getSpent.mockImplementation(async (key: string) => (key.startsWith('signup:') ? 1200 : 40));
  h.countPendingRiskReviews.mockResolvedValue(4);
  h.countHeld.mockResolvedValue(9);
  h.countDomainHolds.mockResolvedValue(2);
  h.summarizeWindow.mockImplementation(async (since: Date) =>
    window(NOW.getTime() - since.getTime() === DAY_MS ? 5 : 20)
  );
});

describe('getIncidentState', () => {
  it('maps settings, queues and both payment windows', async () => {
    const state = await getIncidentState(NOW);

    expect(state).toEqual({
      generatedAt: NOW.toISOString(),
      defenses: {
        turnstile: { enabled: true, failClosed: false, secretConfigured: true },
        grantBudget: {
          day: '2026-11-02',
          pools: [
            { pool: 'signup', limit: 5000, spentToday: 1200, missing: false },
            { pool: 'trickle', limit: 0, spentToday: 40, missing: true },
          ],
        },
        newAccountSpendCapDays: 7,
        paymentRisk: {
          alertsEnabled: true,
          autoRefundEnabled: false,
          linkedAccountActions: true,
          checkoutMaxBlockedAttempts: 3,
        },
      },
      queues: { riskReviewsPending: 4, heldGrants: 9, domainHoldsPending: 2 },
      payments: { last24h: window(5), last7d: window(20) },
    });
    expect(h.getSpent.mock.calls.map(([key]) => key)).toEqual(['signup:2026-11-02', 'trickle:2026-11-02']);
    expect(h.countDomainHolds).toHaveBeenCalledWith({ status: 'held_pending_review' });
    expect(h.summarizeWindow.mock.calls.map(([since]) => (since as Date).toISOString())).toEqual([
      new Date(NOW.getTime() - DAY_MS).toISOString(),
      new Date(NOW.getTime() - 7 * DAY_MS).toISOString(),
    ]);
  });

  it('reports switched-off caps as null, with setting defaults for the rest', async () => {
    h.secret = 'not-configured';
    h.settings.mockResolvedValue(
      storedSettings({ newAccountSpendCapDays: 0, paymentRiskCheckoutMaxBlockedAttempts: 0 })
    );

    const { defenses } = await getIncidentState(NOW);

    expect(defenses.newAccountSpendCapDays).toBeNull();
    expect(defenses.paymentRisk?.checkoutMaxBlockedAttempts).toBeNull();
    expect(defenses.turnstile).toEqual({ enabled: false, failClosed: false, secretConfigured: false });
    expect(defenses.paymentRisk).toMatchObject({
      alertsEnabled: true,
      autoRefundEnabled: true,
      linkedAccountActions: true,
    });
    expect(defenses.error).toBeUndefined();
  });

  it('reports the Turnstile secret as unknown (null) when reading it throws', async () => {
    h.secretThrows = true;

    const { defenses } = await getIncidentState(NOW);

    expect(defenses.turnstile).toEqual({ enabled: true, failClosed: false, secretConfigured: null });
  });

  it('keeps every other section when one read fails', async () => {
    h.settings.mockRejectedValue(new Error('settings down'));
    h.countHeld.mockRejectedValue(new Error('count down'));
    h.summarizeWindow.mockImplementation(async (since: Date) => {
      if (NOW.getTime() - since.getTime() === DAY_MS) throw new Error('aggregate down');
      return window(20);
    });

    const state = await getIncidentState(NOW);

    expect(state.defenses).toEqual({
      turnstile: null,
      grantBudget: null,
      newAccountSpendCapDays: null,
      paymentRisk: null,
      error: 'Settings could not be read',
    });
    expect(state.queues).toEqual({
      riskReviewsPending: 4,
      heldGrants: null,
      domainHoldsPending: 2,
      error: 'Could not count: held grants',
    });
    expect(state.payments).toEqual({
      last24h: null,
      last7d: window(20),
      error: 'Payment attempts could not be summarized',
    });
  });

  it('keeps the settings when only the budget spend read fails', async () => {
    h.getSpent.mockRejectedValue(new Error('budget down'));

    const { defenses } = await getIncidentState(NOW);

    expect(defenses.grantBudget).toBeNull();
    expect(defenses.turnstile?.enabled).toBe(true);
    expect(defenses.error).toBe('Signup grant budget could not be read');
  });
});
