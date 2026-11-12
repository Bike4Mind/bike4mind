import type { APIRequestContext, APIResponse } from '@playwright/test';
import { settingsMap, type SettingKey } from '@bike4mind/common';
import { test, expect, openPageAs } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateThrowawayUser, apiGetAdminSettings, apiUpdateAdminSetting } from './helpers/api';
import { expectsApiRateLimitEnforcement, isSharedRealEnv, isStagingEnv } from './helpers/env';
import { getTestUsers } from './helpers/test-users';
import { BasePage } from './pages/BasePage';
import { ChatPage } from './pages/ChatPage';
import { NavigationPage } from './pages/NavigationPage';

/**
 * Free-tier limits: the per-user set-balance adjustment, which accounts the daily caps apply to, the
 * free-tier rate limit at 0, and the daily spend cap.
 *
 * The limits are global admin settings, so there are two modes:
 * - Previews and production-mode localhost: the zero-limit and spend-cap tests set small values and put every touched
 *   setting back afterwards (a missing row goes back to its registry default).
 * - Staging (the scheduled runs, shared with real users): no global setting is written. Those tests
 *   skip, and a read-only check asserts a fresh free account gets past both gates at staging's own
 *   values. Per-user writes on accounts this file creates still run. Production is skipped.
 *
 * Every account here is minted without the predefined Developer tag, which bypasses both limits.
 * Development targets skip the zero-limit case because that server mode deliberately bypasses rate limits.
 *
 * Serial mode: the global-setting tests change limits every free account on the env shares.
 */
test.describe.configure({ mode: 'serial' });

const API_URL = process.env.API_URL || 'http://localhost:3000';
const LIVE = isStagingEnv();

const BLOCKED_MESSAGE = 'Requests to this endpoint are currently blocked for your account.';
const DAILY_CAP_MESSAGE = 'Daily free-tier credit limit reached. Try again tomorrow.';
const DAILY_CAP_TOAST =
  "You have reached today's free-tier credit limit. It resets at midnight UTC, or upgrade your plan to keep going.";

// Server-side setting caches are per process, and a write clears only the process that took it, so
// after a write every other process keeps the old value for up to one TTL.
// The tier limit: TIER_SETTINGS_CACHE_TTL_MS in packages/server-utils/src/utils/userRateTier.ts.
const RATE_TIER_CACHE_TTL_MS = 15_000;
// The daily caps: the shared settings cache in b4m-core/utils/src/settings.ts.
const SETTINGS_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MARGIN_MS = 5_000;

const priorSettings: Partial<Record<SettingKey, unknown>> = {};

function adminToken(): string {
  return getTestUsers().admin.accessToken;
}

async function createFreeUser(request: APIRequestContext, label: string) {
  return apiCreateThrowawayUser(request, label, { includePredefinedTags: false });
}

/** Records a setting's current value (its registry default if unset) before the first write to it. */
async function setGlobalSetting(request: APIRequestContext, key: SettingKey, value: unknown) {
  if (!(key in priorSettings)) {
    const current = await apiGetAdminSettings(request, adminToken());
    priorSettings[key] = current.has(key) ? current.get(key) : settingsMap[key].defaultValue;
  }
  await apiUpdateAdminSetting(request, adminToken(), key, value);
}

/** Each key is forgotten only once restored, so a failed write is retried by afterAll. */
async function restoreGlobalSettings(request: APIRequestContext) {
  for (const [key, value] of Object.entries(priorSettings)) {
    await apiUpdateAdminSetting(request, adminToken(), key, value);
    delete priorSettings[key as SettingKey];
  }
}

/**
 * A chat request that creates nothing: /api/chat runs its rate limit and daily-cap gate before it
 * resolves the notebook, then refuses sessionId together with newConversation with a 422. So 422 means
 * both gates admitted the caller, and 429 means one of them refused.
 */
async function probeChatGates(request: APIRequestContext, token: string): Promise<APIResponse> {
  return request.post(`${API_URL}/api/chat`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message: 'E2E gate probe', sessionId: '0'.repeat(24), newConversation: true },
  });
}

/** Waits until every server process has reloaded a setting written at `writtenAt`, so one probe is deterministic. */
async function waitOutCache(writtenAt: number, ttlMs: number) {
  const remaining = writtenAt + ttlMs + CACHE_MARGIN_MS - Date.now();
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}

async function numberSetting(request: APIRequestContext, key: SettingKey): Promise<number> {
  const parsed = settingsMap[key].schema.safeParse((await apiGetAdminSettings(request, adminToken())).get(key));
  return Number(parsed.success && parsed.data !== undefined ? parsed.data : settingsMap[key].defaultValue);
}

async function creditSummary(request: APIRequestContext, userId: string) {
  const response = await request.get(`${API_URL}/api/admin/users/${userId}/credit-summary`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });
  expect(response.ok(), `credit-summary: ${response.status()}`).toBe(true);
  return (await response.json()) as {
    balance: number;
    systemCost: { todayUsd: number; dailyCapUsd: number; capApplies: boolean };
  };
}

test.describe('Free-tier limits', () => {
  test.beforeAll(() => {
    test.skip(isSharedRealEnv() && !LIVE, 'Never runs on production.');
  });

  test.afterAll(async ({ request }) => {
    await restoreGlobalSettings(request);
  });

  test('an admin set-balance adjustment sets a free account to an exact balance', async ({ request }) => {
    const user = await createFreeUser(request, 'ftlbalance');
    const setBalance = async (currentCredits: number) => {
      const response = await request.put(`${API_URL}/api/users/${user.userId}/update`, {
        headers: { Authorization: `Bearer ${adminToken()}` },
        data: { currentCredits, creditReason: 'E2E free-tier set-balance check' },
      });
      expect(response.ok(), `set balance to ${currentCredits}: ${response.status()} ${await response.text()}`).toBe(
        true
      );
      const self = await request.get(`${API_URL}/api/users/${user.userId}`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      expect(self.ok()).toBe(true);
      expect(((await self.json()) as { currentCredits: number }).currentCredits).toBe(currentCredits);
      expect((await creditSummary(request, user.userId)).balance).toBe(currentCredits);
    };

    await setBalance(42);
    // Zero is the case the set mode exists for: a delta cannot name it without knowing the balance.
    await setBalance(0);
  });

  test('the daily system cost cap applies to a free account and not to a developer', async ({ request }) => {
    const free = await createFreeUser(request, 'ftlcapfree');
    const developer = await apiCreateThrowawayUser(request, 'ftlcapdev');

    const freeSummary = await creditSummary(request, free.userId);
    // Compared against the summary's own cap so a settings cache refresh between two reads cannot split them.
    expect(freeSummary.systemCost.capApplies).toBe(freeSummary.systemCost.dailyCapUsd > 0);
    expect(freeSummary.systemCost.todayUsd).toBe(0);

    expect((await creditSummary(request, developer.userId)).systemCost.capApplies).toBe(false);
  });

  test('a fresh free account passes the rate limit and the daily cap (staging, read-only)', async ({ request }) => {
    test.skip(!LIVE, 'The zero-limit and spend-cap tests below cover both gates off staging.');
    const user = await createFreeUser(request, 'ftlprobe');
    const freeLimit = await numberSetting(request, 'apiRateLimitFreePerMin');
    const probe = await probeChatGates(request, user.accessToken);
    const body = await probe.text();

    if (freeLimit === 0) {
      expect(probe.status(), body).toBe(429);
      expect(JSON.parse(body).error).toBe(BLOCKED_MESSAGE);
    } else {
      // A new account has spent nothing today, so no daily cap value can refuse it.
      expect(probe.status(), body).toBe(422);
    }
  });

  test('a zero free-tier rate limit blocks a free account and not a developer', async ({ request }) => {
    test.skip(LIVE, 'Needs a global rate-limit change, which staging must never get.');
    test.skip(
      !expectsApiRateLimitEnforcement(),
      'Development servers intentionally bypass rate limits. Set E2E_API_RUNTIME=production only for a production-mode target.'
    );
    test.setTimeout(TIMEOUTS.TEST + 2 * (RATE_TIER_CACHE_TTL_MS + CACHE_MARGIN_MS));
    const free = await createFreeUser(request, 'ftlzero');
    const developer = await apiCreateThrowawayUser(request, 'ftlzerodev');

    await setGlobalSetting(request, 'apiRateLimitFreePerMin', 0);
    try {
      await waitOutCache(Date.now(), RATE_TIER_CACHE_TTL_MS);
      const blocked = await probeChatGates(request, free.accessToken);
      expect(blocked.status()).toBe(429);
      expect((await blocked.json()).error).toBe(BLOCKED_MESSAGE);
      // A non-AI read on the public API is tier-limited too.
      const read = await request.get(`${API_URL}/api/v1/embedding-models`, {
        headers: { Authorization: `Bearer ${free.accessToken}` },
      });
      expect(read.status()).toBe(429);

      expect((await probeChatGates(request, developer.accessToken)).status()).toBe(422);
    } finally {
      // Restored inside the test so the block lasts no longer than it must for other free accounts.
      await restoreGlobalSettings(request);
    }

    await waitOutCache(Date.now(), RATE_TIER_CACHE_TTL_MS);
    expect((await probeChatGates(request, free.accessToken)).status()).toBe(422);
  });

  test('a free account that reaches the daily spend cap is refused until UTC midnight', async ({
    request,
    browser,
    baseURL,
  }) => {
    test.skip(LIVE, 'Needs a global spend-cap change, which staging must never get.');
    // afterAll restores the caps, but other processes keep the 1-credit cap for up to one cache TTL after.
    test.setTimeout(SETTINGS_CACHE_TTL_MS + 3 * TIMEOUTS.AI_RESPONSE);
    const user = await createFreeUser(request, 'ftlspend');

    // One credit is the smallest cap, and usdToCredits charges at least one credit per paid turn.
    await setGlobalSetting(request, 'freeTierDailySpendCapCredits', 1);
    await setGlobalSetting(request, 'freeTierDay1SpendCapCredits', 1);
    // Off, so only the credit cap can refuse; it has its own message.
    await setGlobalSetting(request, 'freeTierDailySystemCostCapUsd', 0);
    const writtenAt = Date.now();

    const turn = await request.post(`${API_URL}/api/chat`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { message: 'Reply with the single word: ok', wait: true, newConversation: true, toolMode: 'fast' },
      timeout: TIMEOUTS.AI_RESPONSE,
    });
    const turnBody = await turn.text();
    expect(turn.status(), turnBody).toBe(200);
    expect(JSON.parse(turnBody).type, turnBody).not.toBe('error');

    await waitOutCache(writtenAt, SETTINGS_CACHE_TTL_MS);
    const capped = await probeChatGates(request, user.accessToken);
    expect(capped.status()).toBe(429);
    expect(await capped.json()).toMatchObject({ errorCode: 'daily_free_limit_reached', error: DAILY_CAP_MESSAGE });
    const retryAfter = Number(capped.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);

    const { page, close } = await openPageAs(browser, baseURL, user);
    try {
      const basePage = new BasePage(page);
      await page.goto('/');
      await basePage.dismissModals();
      await new NavigationPage(page).navigateToNewChat();
      await new ChatPage(page).sendMessage('Say hi.');
      await basePage.waitForToast(DAILY_CAP_TOAST);
    } finally {
      await close();
    }
  });
});
