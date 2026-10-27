// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { apiGetTeam } from '../e2e/helpers/api';

vi.mock('@playwright/test', () => ({ test: {} }));

describe('apiGetTeam', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  function createRequest(status: number, body: unknown = { error: 'Request failed' }) {
    const response = {
      status: () => status,
      ok: () => status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } satisfies Pick<APIResponse, 'status' | 'ok' | 'json' | 'text'>;
    const get = vi.fn<APIRequestContext['get']>().mockResolvedValue(response as APIResponse);
    const request = { get } satisfies Pick<APIRequestContext, 'get'>;
    return { request: request as APIRequestContext, get };
  }

  it('returns the team and authenticates the request', async () => {
    vi.stubEnv('API_URL', 'https://example.com');
    const team = { id: 'team-id', name: 'Test team', seats: 6 };
    const { request, get } = createRequest(200, team);
    await expect(apiGetTeam(request, 'owner-token', 'team-id')).resolves.toEqual(team);
    expect(get).toHaveBeenCalledWith('https://example.com/api/organizations/team-id', {
      headers: { Authorization: 'Bearer owner-token' },
    });
  });

  it('returns null only when the team is missing or inaccessible', async () => {
    const { request } = createRequest(404);
    await expect(apiGetTeam(request, 'owner-token', 'team-id')).resolves.toBeNull();
  });

  it.each([401, 403, 500])('reports HTTP %s instead of claiming the team is gone', async status => {
    const { request } = createRequest(status, { error: 'Specific server diagnostic' });
    await expect(apiGetTeam(request, 'owner-token', 'team-id')).rejects.toThrow(
      `Get team failed: ${status} {"error":"Specific server diagnostic"}`
    );
  });

  it('preserves transport failures instead of claiming the team is gone', async () => {
    const { request, get } = createRequest(200);
    const failure = new Error('Connection reset');
    get.mockRejectedValue(failure);
    await expect(apiGetTeam(request, 'owner-token', 'team-id')).rejects.toBe(failure);
  });
});
