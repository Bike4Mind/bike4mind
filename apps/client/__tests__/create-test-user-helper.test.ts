// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { apiCreateTestUser } from '../e2e/helpers/api';
import { enrollMfa } from '../e2e/helpers/mfa';

vi.mock('@playwright/test', () => ({ test: {} }));
vi.mock('../e2e/helpers/mfa', () => ({ enrollMfa: vi.fn() }));

const params = {
  username: 'helper-e2e',
  email: 'helper-e2e@test.com',
  name: 'Helper',
  password: 'private-password',
};

function createRequest(status: number, body: unknown = {}) {
  const response = {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  } satisfies Pick<APIResponse, 'status' | 'ok' | 'json' | 'text'>;
  const post = vi.fn<APIRequestContext['post']>().mockResolvedValue(response as APIResponse);
  return { request: { post } as unknown as APIRequestContext, post, response };
}

describe('apiCreateTestUser correlation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([400, 401, 403, 500, 502, 503])('fails once with safe correlation for HTTP %s', async status => {
    vi.stubEnv('E2E_CLEANUP_SECRET', 'private-cleanup-secret');
    vi.stubEnv('API_URL', 'https://example.com');
    const { request, post, response } = createRequest(status, {
      error: params.email,
      accessToken: 'private-access-token',
      refreshToken: 'private-refresh-token',
    });

    const failure = await apiCreateTestUser(request, params).catch((error: unknown) => error);

    expect(post).toHaveBeenCalledTimes(1);
    const requestId = post.mock.calls[0][1]?.headers?.['X-Request-ID'];
    expect(requestId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    expect(post).toHaveBeenCalledWith('https://example.com/api/test/create-user', {
      data: params,
      headers: { 'x-e2e-cleanup-secret': 'private-cleanup-secret', 'X-Request-ID': requestId },
    });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`POST /api/test/create-user failed: ${status} (request_id=${requestId})`);
    expect(response.json).not.toHaveBeenCalled();
    expect(response.text).not.toHaveBeenCalled();
    expect(enrollMfa).not.toHaveBeenCalled();
  });

  it('uses distinct IDs and preserves successful session setup and MFA enrollment', async () => {
    vi.stubEnv('E2E_CLEANUP_SECRET', 'private-cleanup-secret');
    const created = {
      user: { id: 'user-id', aupAcceptedVersion: 'accepted' },
      accessToken: 'creation-access-token',
      refreshToken: 'creation-refresh-token',
    };
    const tokens = { accessToken: 'mfa-access-token', refreshToken: 'mfa-refresh-token' };
    vi.mocked(enrollMfa).mockResolvedValue({ tokens } as Awaited<ReturnType<typeof enrollMfa>>);
    const { request, post } = createRequest(201, created);

    await expect(apiCreateTestUser(request, params)).resolves.toEqual({ ...created, ...tokens });
    await expect(apiCreateTestUser(request, { ...params, mfa: 'unenrolled' })).resolves.toEqual(created);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1]?.headers?.['X-Request-ID']).not.toBe(post.mock.calls[1][1]?.headers?.['X-Request-ID']);
    expect(enrollMfa).toHaveBeenCalledExactlyOnceWith(request, created.accessToken);
  });

  it('does not retry a transport failure', async () => {
    vi.stubEnv('E2E_CLEANUP_SECRET', 'private-cleanup-secret');
    const { request, post } = createRequest(201);
    const failure = new Error('Connection reset');
    post.mockRejectedValueOnce(failure);

    await expect(apiCreateTestUser(request, params)).rejects.toBe(failure);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
