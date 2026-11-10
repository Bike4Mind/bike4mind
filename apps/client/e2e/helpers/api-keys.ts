import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { settingsMap } from '@bike4mind/common';
import { wafBypassHeaders } from './waf-bypass';

// Personal API key gates: the access switch (apiKeyAccessGate.ts) and the trust gate
// (b4m-core/services/src/userApiKeyService/trust.ts), read and exercised over the API.

const baseURL = () => process.env.API_URL || 'http://localhost:3000';

/** POSTs to csrfProtection routes need a same-origin Origin header; without it they 403 for the wrong reason. */
const writeHeaders = (token: string) => ({
  ...wafBypassHeaders(),
  Authorization: `Bearer ${token}`,
  Origin: new URL(baseURL()).origin,
});

export interface ApiKeyEligibility {
  canCreate: boolean;
  message: string | null;
  refusedOrgIds: string[];
}

export async function apiGetApiKeyEligibility(request: APIRequestContext, token: string): Promise<ApiKeyEligibility> {
  const response = await request.get(`${baseURL()}/api/user-api-keys/eligibility`, {
    headers: { ...wafBypassHeaders(), Authorization: `Bearer ${token}` },
  });
  expect(response.status(), 'GET /api/user-api-keys/eligibility').toBe(200);
  return response.json();
}

/** Mints a personal key. Returns the raw response so a caller can assert a refusal as well as a 201. */
export function apiMintUserApiKey(
  request: APIRequestContext,
  token: string,
  body: { name: string; scopes: string[]; rateLimit?: { requestsPerMinute: number; requestsPerDay: number } }
): Promise<APIResponse> {
  return request.post(`${baseURL()}/api/user-api-keys`, { headers: writeHeaders(token), data: body });
}

/** Mints a key and returns its one-time plaintext. */
export async function apiMintUserApiKeySecret(
  request: APIRequestContext,
  token: string,
  body: Parameters<typeof apiMintUserApiKey>[2]
): Promise<string> {
  const response = await apiMintUserApiKey(request, token, body);
  expect(response.status(), `mint ${body.name}: ${await response.text()}`).toBe(201);
  return ((await response.json()) as { key: string }).key;
}

export async function apiSetApiKeyTrust(
  request: APIRequestContext,
  adminToken: string,
  userId: string,
  approved: boolean
): Promise<void> {
  const response = await request.post(`${baseURL()}/api/admin/users/${userId}/api-key-trust`, {
    headers: writeHeaders(adminToken),
    data: { approved, reason: 'E2E API key trust gate check' },
  });
  expect(response.status(), `api-key-trust: ${await response.text()}`).toBe(200);
}

type SettingRow = { settingName: string; settingValue: unknown };

async function apiFetchSettings(request: APIRequestContext, adminToken: string): Promise<Map<string, unknown>> {
  const response = await request.get(`${baseURL()}/api/settings/fetch`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(response.status(), 'GET /api/settings/fetch').toBe(200);
  const rows = (await response.json()) as SettingRow[];
  return new Map(rows.map(row => [row.settingName, row.settingValue]));
}

export type ApiKeyAccessMode = 'all' | 'paid' | 'disabled';

/** The access switch as the server reads it: anything but `all` or `disabled`, a missing row included, is `paid`. */
export async function apiReadApiKeyAccessMode(
  request: APIRequestContext,
  adminToken: string
): Promise<ApiKeyAccessMode> {
  const value = (await apiFetchSettings(request, adminToken)).get('apiKeyAccess');
  return value === 'all' || value === 'disabled' ? value : 'paid';
}

export interface ApiKeyTrustSettings {
  gateEnabled: boolean;
  minAccountAgeDays: number;
  accountAgeTrustsKeys: boolean;
  maxActiveKeysUntrusted: number;
}

/** The trust settings with the server's own defaults for a missing row (loadApiKeyTrustSettings). */
export async function apiReadApiKeyTrustSettings(
  request: APIRequestContext,
  adminToken: string
): Promise<ApiKeyTrustSettings> {
  const settings = await apiFetchSettings(request, adminToken);
  const read = <K extends keyof typeof settingsMap>(key: K) =>
    settings.has(key) ? settings.get(key) : settingsMap[key].schema.parse(undefined);
  return {
    gateEnabled: read('apiKeyTrustGateEnabled') as boolean,
    minAccountAgeDays: read('apiKeyMinAccountAgeDays') as number,
    accountAgeTrustsKeys: read('apiKeyAccountAgeTrustsKeys') as boolean,
    maxActiveKeysUntrusted: read('maxActiveKeysUntrusted') as number,
  };
}
