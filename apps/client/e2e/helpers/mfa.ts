import { type APIRequestContext } from '@playwright/test';
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

/** Generate a TOTP code for a base32 secret, matching what an authenticator app would show. */
export function generateTotp(secretBase32: string): string {
  return speakeasy.totp({ secret: secretBase32, encoding: 'base32' });
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
 * and the post-enroll token pair (the pre-enroll accessToken passed in is no longer valid).
 */
export async function enrollMfa(
  request: APIRequestContext,
  accessToken: string
): Promise<{ secret: string; backupCodes: string[]; tokens: MfaTokens }> {
  const setup = await apiSetupMfa(request, accessToken);
  const code = generateTotp(setup.secret);
  const tokens = await apiVerifyMfaSetup(request, accessToken, code);
  return { secret: setup.secret, backupCodes: setup.backupCodes, tokens };
}
