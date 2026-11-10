import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { CURRENT_POLICY_VERSION, settingsMap } from '@bike4mind/common';
import { apiCreateInviteCode, apiDeleteInviteCode, apiSendOtcAndReadCode, apiUpdateAdminSetting } from '../helpers/api';
import { getE2ETestId, getTestRunId, getTestUsers } from '../helpers/test-users';
import { wafBypassHeaders } from '../helpers/waf-bypass';

export const apiUrl = (): string => process.env.API_URL || 'http://localhost:3000';

export const adminToken = (): string => getTestUsers().admin.accessToken;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * A test address and username unique to this test attempt and inside this run's cleanup scope. The
 * retry and repeat indexes are part of it so a retried test never collides with its own first try.
 * `tag`, when given, goes after a `+` in the local part, so two calls with different tags make the
 * plus aliases of one base inbox.
 */
export function freshIdentity(label: string, tag?: string): { email: string; username: string } {
  const e2eId = getE2ETestId();
  const idSuffix = e2eId ? `${e2eId}-${getTestRunId()}` : getTestRunId();
  const { retry, repeatEachIndex } = test.info();
  const slug = `lr-${label}${retry}r${repeatEachIndex}`;
  return {
    email: `${slug}${tag ? `+${tag}` : ''}-${idSuffix}-e2e@test.com`,
    username: `${slug}${tag ?? ''}-${idSuffix}`,
  };
}

/** Rows the stage stored for these settings; a key that is absent means the code default applies. */
export async function readStoredSettings(
  request: APIRequestContext,
  keys: readonly string[]
): Promise<Map<string, unknown>> {
  const res = await request.get(`${apiUrl()}/api/settings/fetch`, { headers: bearer(adminToken()) });
  if (!res.ok()) throw new Error(`Settings fetch failed: ${res.status()}`);
  const rows = (await res.json()) as { settingName: string; settingValue: unknown }[];
  return new Map(rows.filter(row => keys.includes(row.settingName)).map(row => [row.settingName, row.settingValue]));
}

const definitionDefault = (key: string): unknown =>
  (settingsMap as Record<string, { defaultValue?: unknown }>)[key]?.defaultValue;

/** The value in force: the stored row, else the definition default. */
export async function liveSetting<T>(request: APIRequestContext, key: string): Promise<T> {
  const stored = await readStoredSettings(request, [key]);
  return (stored.has(key) ? stored.get(key) : definitionDefault(key)) as T;
}

/**
 * Apply admin-setting overrides for the length of `body`, then put back what was there before (the
 * stored row, or the definition default when nothing was stored). Callers must check
 * canChangeSettings() first.
 */
export async function withSettings<T>(
  request: APIRequestContext,
  overrides: Record<string, unknown>,
  body: () => Promise<T>
): Promise<T> {
  const keys = Object.keys(overrides);
  const prior = await readStoredSettings(request, keys);
  const applied: string[] = [];
  try {
    for (const key of keys) {
      await apiUpdateAdminSetting(request, adminToken(), key, overrides[key]);
      applied.push(key);
    }
    return await body();
  } finally {
    await restoreSettings(request, prior, applied.reverse());
  }
}

/** Put each key back to its row in `prior` (from readStoredSettings), or the definition default when it had none. */
export async function restoreSettings(
  request: APIRequestContext,
  prior: Map<string, unknown>,
  keys: readonly string[]
): Promise<void> {
  for (const key of keys) {
    await apiUpdateAdminSetting(request, adminToken(), key, prior.has(key) ? prior.get(key) : definitionDefault(key));
  }
}

export async function isOpenRegistrationOn(request: APIRequestContext): Promise<boolean> {
  const res = await request.get(`${apiUrl()}/api/settings/serverConfigPublic`);
  return res.ok() ? Boolean((await res.json()).allowOpenRegistration) : false;
}

/**
 * The real OTC registration: send, read the code back, verify with a username. Returns the verify
 * response untouched so a caller can assert a refusal as well as a success.
 */
export async function postOtcRegistration(
  request: APIRequestContext,
  params: { email: string; username: string; inviteCode?: string }
): Promise<APIResponse> {
  const { pendingToken, code } = await apiSendOtcAndReadCode(request, params.email);
  return request.post(`${apiUrl()}/api/otc/verify`, {
    headers: wafBypassHeaders(),
    data: {
      email: params.email,
      code,
      pendingToken,
      username: params.username,
      ...(params.inviteCode ? { inviteCode: params.inviteCode } : {}),
      acceptedPolicyVersion: CURRENT_POLICY_VERSION,
      ageAttestation: true,
    },
  });
}

export interface FreshAccount {
  email: string;
  userId: string;
  accessToken: string;
  /** True when open registration was off and the account came in on an admin invite code. */
  invited: boolean;
}

/**
 * Invite code for one signup when the stage keeps open registration off (staging does), else null.
 * Delete it with discardSignupInvite once the signup is done.
 */
export async function signupInviteIfNeeded(request: APIRequestContext): Promise<{ id: string; code: string } | null> {
  return (await isOpenRegistrationOn(request)) ? null : apiCreateInviteCode(request, adminToken());
}

export async function discardSignupInvite(request: APIRequestContext, invite: { id: string } | null): Promise<void> {
  if (invite) await apiDeleteInviteCode(request, adminToken(), invite.id).catch(() => undefined);
}

/**
 * A brand-new, email-verified account made through the same OTC registration a person uses. Skips
 * the calling test when the stage's signup network limits refuse the runner, which says nothing
 * about the gate under test.
 */
export async function registerFreshAccount(
  request: APIRequestContext,
  identity: { email: string; username: string }
): Promise<FreshAccount> {
  const invite = await signupInviteIfNeeded(request);
  try {
    const res = await postOtcRegistration(request, { ...identity, inviteCode: invite?.code });
    test.skip(
      res.status() === 429,
      "The stage's signup network limit (maxSignupsPerIpPerDay / maxSignupsPerAsnPerHour) refused this runner"
    );
    if (!res.ok()) throw new Error(`Registration failed: ${res.status()} ${await res.text()}`);
    const body = (await res.json()) as { user: { id: string }; accessToken: string };
    return { email: identity.email, userId: body.user.id, accessToken: body.accessToken, invited: invite !== null };
  } finally {
    await discardSignupInvite(request, invite);
  }
}

/** The user fields these specs read. Admin-only fields are absent from a self read. */
export interface UserRecord {
  id: string;
  currentCredits?: number;
  isBanned?: boolean;
  isSynthetic?: boolean;
  signupInvite?: unknown;
  signupGrant?: {
    stage: string;
    signupCredits: number;
    unlockCredits: number;
    creditsReleased: number;
    inviteBonusPaid?: number;
    heldUnlock?: { releaseAt: string };
  };
  signupGrantHeldReason?: string | null;
  signupGrantAssessment?: {
    band: string;
    credits: number;
    status: string;
    reasons?: string[];
    signals?: Record<string, unknown>;
  };
  riskSignals?: { type: string }[];
  signupMeta?: { asn?: number | null; isDatacenter?: boolean | null; country?: string | null; capturedAt?: string };
}

/** The full user record as an admin sees it (signupMeta, signupGrantAssessment and riskSignals included). */
export async function adminReadUser(request: APIRequestContext, userId: string): Promise<UserRecord> {
  const res = await request.get(`${apiUrl()}/api/users/${userId}`, { headers: bearer(adminToken()) });
  if (!res.ok()) throw new Error(`Admin user read failed: ${res.status()}`);
  return res.json();
}

/**
 * The admin view of a new account once its signup tranche has settled: released, held, or never
 * staged. Fails when the tranche is still pending with no hold, since verification should settle it.
 */
export async function settledSignupGrant(request: APIRequestContext, userId: string): Promise<UserRecord> {
  let record = await adminReadUser(request, userId);
  await expect
    .poll(
      async () => {
        record = await adminReadUser(request, userId);
        return record.signupGrant?.stage === 'pending_email' && !record.signupGrantHeldReason;
      },
      { message: 'the signup tranche settles after verification', timeout: 15_000 }
    )
    .toBe(false);
  return record;
}

/** The caller's own record, as the account itself sees it. */
export async function selfReadUser(
  request: APIRequestContext,
  account: { userId: string; accessToken: string }
): Promise<UserRecord> {
  const res = await request.get(`${apiUrl()}/api/users/${account.userId}`, { headers: bearer(account.accessToken) });
  if (!res.ok()) throw new Error(`Self user read failed: ${res.status()}`);
  return res.json();
}

/**
 * Makes every gtag() call observable, whatever GA4 setup the stage has. gtag queues each call on
 * window.dataLayer, and the GA snippet's own gtag and gtag.js's later replacement of dataLayer.push
 * both go through the accessor below, so every queued call is copied aside. A stage without GA gets a
 * gtag shaped like the snippet's, so the app still has one to call.
 */
export async function recordGtagCalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Layer = unknown[] & { push: (...items: unknown[]) => number };
    const w = window as unknown as { dataLayer?: Layer; gtag?: () => void; __lrGtagCalls?: unknown[] };
    const seen: unknown[] = [];
    const layer = (w.dataLayer ?? []) as Layer;
    let push: (...items: unknown[]) => number = Array.prototype.push;
    Object.defineProperty(layer, 'push', {
      configurable: true,
      get:
        () =>
        (...items: unknown[]) => {
          seen.push(...items);
          return push.apply(layer, items);
        },
      set: (replacement: (...items: unknown[]) => number) => {
        push = replacement;
      },
    });
    w.dataLayer = layer;
    w.__lrGtagCalls = seen;
    w.gtag = function () {
      // eslint-disable-next-line prefer-rest-params -- gtag queues the Arguments object itself.
      layer.push(arguments);
    };
  });
}

/** Names of the gtag('event', name, ...) calls made so far. */
export async function gtagEventNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as { __lrGtagCalls?: unknown[] }).__lrGtagCalls ?? [])
      .filter((call): call is ArrayLike<unknown> => !!call && typeof call === 'object' && 'length' in call)
      .filter(call => call[0] === 'event')
      .map(call => String(call[1]))
  );
}

/** Pre-decide the cookie banner as granted; runs after the fixture's default of denied. */
export async function grantCookieConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cookie_consent', 'granted');
    } catch {
      // Opaque origins (about:blank) have no localStorage.
    }
  });
}
