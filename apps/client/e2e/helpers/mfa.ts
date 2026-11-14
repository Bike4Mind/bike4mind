import { type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import speakeasy from 'speakeasy';
import { refreshTokenFromSetCookie } from './api';

export interface MfaSetupResult {
  secret: string;
  qrCodeUrl: string;
  manualEntryKey: string;
  backupCodes: string[];
}

export interface MfaTokens {
  accessToken: string;
  refreshToken: string;
}

const TOTP_STEP_SECONDS = 30;

function currentTotpStep(): number {
  return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Generate a TOTP code for a base32 secret, matching what an authenticator app would show.
 * The server rejects a code whose step is not newer than the last one it accepted (replay
 * guard), so pass `afterStep` (e.g. enrollMfa's `enrolledStep`) to get a code it will still take.
 * A code one step ahead is fine: the server verifies with a window of 1 step either side.
 */
export function generateTotp(secretBase32: string, afterStep?: number): string {
  const step = afterStep === undefined ? currentTotpStep() : Math.max(currentTotpStep(), afterStep + 1);
  return speakeasy.totp({ secret: secretBase32, encoding: 'base32', time: step * TOTP_STEP_SECONDS });
}

/** POST /api/auth/mfa/setup - generates a TOTP secret + backup codes (not yet enabled). */
export async function apiSetupMfa(request: APIRequestContext, accessToken: string): Promise<MfaSetupResult> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/auth/mfa/setup`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`MFA setup failed: ${response.status()} ${response.statusText()}`);
  }
  const result: MfaSetupResult = await response.json();
  return result;
}

/**
 * POST /api/auth/mfa/verify-setup - enables MFA and issues a fresh session. The token used to
 * call apiSetupMfa is invalidated by this call (tokenVersion bump), so callers must switch to the
 * returned tokens for any request made after enrollment. Only the access token is in the body;
 * the refresh token comes back as the HttpOnly cookie, so it has to be read off Set-Cookie.
 */
export async function apiVerifyMfaSetup(
  request: APIRequestContext,
  accessToken: string,
  code: string
): Promise<MfaTokens> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/auth/mfa/verify-setup`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { token: code },
  });
  if (!response.ok()) {
    throw new Error(`MFA verify-setup failed: ${response.status()} ${response.statusText()}`);
  }
  const refreshToken = refreshTokenFromSetCookie(response.headers()['set-cookie']);
  const { accessToken: freshAccessToken } = (await response.json()) as { accessToken?: string };
  if (!freshAccessToken || !refreshToken) {
    throw new Error(
      `MFA verify-setup returned no session (accessToken=${freshAccessToken ? 'set' : 'missing'}, ` +
        `refreshCookie=${refreshToken ? 'set' : 'missing'})`
    );
  }
  return { accessToken: freshAccessToken, refreshToken };
}

/**
 * Enroll MFA end-to-end via the API (setup + verify-setup), returning the secret, backup codes,
 * the post-enroll token pair (the pre-enroll accessToken passed in is no longer valid), and the
 * TOTP step the enrollment code consumed.
 */
export async function enrollMfa(
  request: APIRequestContext,
  accessToken: string
): Promise<{ secret: string; backupCodes: string[]; tokens: MfaTokens; enrolledStep: number }> {
  const setup = await apiSetupMfa(request, accessToken);
  const enrolledStep = currentTotpStep();
  const code = speakeasy.totp({ secret: setup.secret, encoding: 'base32', time: enrolledStep * TOTP_STEP_SECONDS });
  const tokens = await apiVerifyMfaSetup(request, accessToken, code);
  return { secret: setup.secret, backupCodes: setup.backupCodes, tokens, enrolledStep };
}

/**
 * Name of the per-account "remember this device" cookie. Mirrors trustedDeviceCookieName in
 * server/auth/trustedDevice.ts - keep in sync.
 */
export function trustedDeviceCookieName(userId: string): string {
  return `b4m_td_${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
}

interface SettingRow {
  settingName: string;
  settingValue: unknown;
}

const ENFORCE_MFA_ROW: SettingRow = { settingName: 'enforceMFA', settingValue: true };

function isSettingRow(value: unknown): value is SettingRow {
  return typeof value === 'object' && value !== null && 'settingName' in value;
}

function withEnforcedMfa(rows: unknown): SettingRow[] {
  const kept = Array.isArray(rows) ? rows.filter(isSettingRow).filter(r => r.settingName !== 'enforceMFA') : [];
  return [...kept, ENFORCE_MFA_ROW];
}

/**
 * Make this page's client see enforceMFA on, without touching the global admin setting: it is
 * stage-wide, and the server reads it through a settings cache, so flipping it would confine
 * every unenrolled session on a shared stage for a cache TTL after it is restored. This covers
 * MFAEnforcementWrapper, not the server's 403 gate.
 * Patches every source the client reads enforcement from: the public CDN artifact,
 * /api/settings/fetch, and the `required` field of /api/auth/mfa/status. Sign-in is decided by
 * the server, so with the stage's real setting on, an unenrolled user is sent to setup at sign-in.
 */
export async function stubEnforcedMfaSetting(page: Page): Promise<void> {
  await page.route('**/app-config/public-settings.json', async route => {
    const response = await route.fetch().catch(() => null);
    const body: unknown = response?.ok() ? await response.json().catch(() => null) : null;
    const artifact = typeof body === 'object' && body !== null ? body : { version: 1, updatedAt: '' };
    const settings = 'settings' in artifact ? artifact.settings : [];
    await route.fulfill({ json: { ...artifact, settings: withEnforcedMfa(settings) } });
  });
  await page.route('**/api/settings/fetch**', async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    await route.fulfill({ response, json: withEnforcedMfa(await response.json()) });
  });
  await page.route('**/api/auth/mfa/status**', async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body: unknown = await response.json();
    const status = typeof body === 'object' && body !== null ? body : {};
    await route.fulfill({ response, json: { ...status, required: true } });
  });
}
