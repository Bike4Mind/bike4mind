// @vitest-environment node
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiReadApiKeyAccessMode } from '../e2e/helpers/api-keys';

function requestFor(body: unknown, status = 200) {
  const get = vi.fn().mockResolvedValue({ status: () => status, json: async () => body } as APIResponse);
  return { get, request: { get } as unknown as APIRequestContext };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('effective API key access mode', () => {
  it.each(['all', 'paid', 'disabled'] as const)('uses the server mode %s regardless of runner defaults', async mode => {
    vi.stubEnv('B4M_SELF_HOST', mode === 'all' ? 'false' : 'true');
    vi.stubEnv('API_URL', 'https://target.invalid');
    vi.stubEnv('E2E_WAF_BYPASS_TOKEN', 'test-bypass');
    const { get, request } = requestFor({ access: { mode, allowed: true, basis: 'admin' } });
    expect(await apiReadApiKeyAccessMode(request, 'admin-token', 'admin-id')).toBe(mode);
    expect(get).toHaveBeenCalledExactlyOnceWith('https://target.invalid/api/admin/users/admin-id/user-api-keys', {
      headers: { Authorization: 'Bearer admin-token', 'x-e2e-waf-bypass': 'test-bypass' },
    });
  });

  it.each([{}, { access: {} }, { access: { mode: 'unknown', allowed: true, basis: 'admin' } }])(
    'rejects a missing or malformed access response',
    async body => {
      const { request } = requestFor(body);
      await expect(apiReadApiKeyAccessMode(request, 'token', 'admin-id')).rejects.toThrow();
    }
  );

  it('rejects an unsuccessful response instead of assuming paid mode', async () => {
    const { request } = requestFor({}, 403);
    await expect(apiReadApiKeyAccessMode(request, 'token', 'admin-id')).rejects.toThrow();
  });
});
