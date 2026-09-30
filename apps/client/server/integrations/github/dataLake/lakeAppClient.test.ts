import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  mockOctokit: { request: vi.fn(), paginate: vi.fn() },
}));

const mockConfig: Record<string, string | undefined> = {};
vi.mock('@server/utils/config', () => ({
  Config: new Proxy({}, { get: (_, key: string) => mockConfig[key] }),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(function () {
    return h.mockOctokit;
  }),
}));
vi.mock('@octokit/auth-app', () => ({ createAppAuth: vi.fn() }));

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import {
  getGitHubLakeAppConfig,
  deleteInstallation,
  listInstallerVisibleRepositories,
  getInstallationOctokit,
  getRepository,
  getBranchHeadSha,
  getRecursiveTree,
  getBlobBytes,
  gitHubErrorStatus,
  gitHubRateLimitDelaySeconds,
  type GitHubLakeAppConfig,
} from './lakeAppClient';

const CONFIG: GitHubLakeAppConfig = {
  appId: 'app-1',
  slug: 'test-lake-app',
  privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
  clientId: 'client-1',
  clientSecret: 'secret-1',
};

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

describe('getGitHubLakeAppConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.GITHUB_LAKE_APP_ID = 'app-1';
    mockConfig.GITHUB_LAKE_APP_SLUG = 'test-lake-app';
    mockConfig.GITHUB_LAKE_APP_PRIVATE_KEY = 'line1\\nline2';
    mockConfig.GITHUB_LAKE_APP_CLIENT_ID = 'client-1';
    mockConfig.GITHUB_LAKE_APP_CLIENT_SECRET = 'secret-1';
  });

  it('returns the config when every secret is set', () => {
    expect(getGitHubLakeAppConfig()).toEqual({
      appId: 'app-1',
      slug: 'test-lake-app',
      privateKey: 'line1\nline2',
      clientId: 'client-1',
      clientSecret: 'secret-1',
    });
  });

  it.each([
    'GITHUB_LAKE_APP_ID',
    'GITHUB_LAKE_APP_SLUG',
    'GITHUB_LAKE_APP_PRIVATE_KEY',
    'GITHUB_LAKE_APP_CLIENT_ID',
    'GITHUB_LAKE_APP_CLIENT_SECRET',
  ])('returns null when %s is the literal "not-configured"', key => {
    mockConfig[key] = 'not-configured';
    expect(getGitHubLakeAppConfig()).toBeNull();
  });

  it('returns null when a secret is undefined', () => {
    mockConfig.GITHUB_LAKE_APP_PRIVATE_KEY = undefined;
    expect(getGitHubLakeAppConfig()).toBeNull();
  });

  it('converts literal \\n escapes in the private key into real newlines', () => {
    mockConfig.GITHUB_LAKE_APP_PRIVATE_KEY = '-----BEGIN KEY-----\\nabc\\n-----END KEY-----';
    expect(getGitHubLakeAppConfig()?.privateKey).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----');
  });
});

describe('deleteInstallation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves without throwing when the installation is already gone (404)', async () => {
    h.mockOctokit.request.mockRejectedValue(notFound());
    await expect(deleteInstallation(CONFIG, 42)).resolves.toBeUndefined();
  });

  it('rethrows any other error', async () => {
    const err = Object.assign(new Error('server error'), { status: 500 });
    h.mockOctokit.request.mockRejectedValue(err);
    await expect(deleteInstallation(CONFIG, 42)).rejects.toBe(err);
  });

  it('calls the delete-installation endpoint with the installation id', async () => {
    h.mockOctokit.request.mockResolvedValue({});
    await deleteInstallation(CONFIG, 42);
    expect(h.mockOctokit.request).toHaveBeenCalledWith('DELETE /app/installations/{installation_id}', {
      installation_id: 42,
    });
  });
});

describe('listInstallerVisibleRepositories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the paginated repositories to id/fullName', async () => {
    h.mockOctokit.paginate.mockResolvedValue([
      { id: 1, full_name: 'acme/one' },
      { id: 2, full_name: 'acme/two' },
    ]);
    await expect(listInstallerVisibleRepositories('user-token', 42)).resolves.toEqual([
      { id: 1, fullName: 'acme/one' },
      { id: 2, fullName: 'acme/two' },
    ]);
  });

  it('returns null when the user cannot see the installation (404)', async () => {
    h.mockOctokit.paginate.mockRejectedValue(notFound());
    await expect(listInstallerVisibleRepositories('user-token', 42)).resolves.toBeNull();
  });

  it('rethrows any other error', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    h.mockOctokit.paginate.mockRejectedValue(err);
    await expect(listInstallerVisibleRepositories('user-token', 42)).rejects.toBe(err);
  });
});

describe('getInstallationOctokit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints an installation token scoped to the one bound repository', async () => {
    const auth = vi.fn().mockResolvedValue({ token: 'inst-token' });
    vi.mocked(createAppAuth).mockReturnValue(auth as never);

    const octokit = await getInstallationOctokit(CONFIG, 42, 7);

    expect(createAppAuth).toHaveBeenCalledWith({ appId: 'app-1', privateKey: CONFIG.privateKey });
    expect(auth).toHaveBeenCalledWith({ type: 'installation', installationId: 42, repositoryIds: [7] });
    expect(Octokit).toHaveBeenLastCalledWith(expect.objectContaining({ auth: 'inst-token' }));
    expect(octokit).toBe(h.mockOctokit);
  });

  it('surfaces the 422 GitHub returns when the repository left the installation', async () => {
    const unprocessable = Object.assign(new Error('Unprocessable Entity'), { status: 422 });
    vi.mocked(createAppAuth).mockReturnValue(vi.fn().mockRejectedValue(unprocessable) as never);
    await expect(getInstallationOctokit(CONFIG, 42, 7)).rejects.toMatchObject({ status: 422 });
  });
});

describe('repository reads', () => {
  const octokitWith = (data: unknown) => ({ request: vi.fn().mockResolvedValue({ data }) });

  it('getRepository returns the live full name and default branch', async () => {
    const octokit = octokitWith({ id: 7, full_name: 'acme/renamed', default_branch: 'trunk' });
    await expect(getRepository(octokit as never, 'acme/old', 7)).resolves.toEqual({
      fullName: 'acme/renamed',
      defaultBranch: 'trunk',
    });
    expect(octokit.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'old' });
  });

  it('getRepository treats a different repository at the stored name as not found', async () => {
    const octokit = octokitWith({ id: 8, full_name: 'acme/old', default_branch: 'main' });
    await expect(getRepository(octokit as never, 'acme/old', 7)).rejects.toMatchObject({ status: 404 });
  });

  it('getBranchHeadSha reads the branch head commit', async () => {
    const octokit = octokitWith({ commit: { sha: 'head-sha' } });
    await expect(getBranchHeadSha(octokit as never, 'acme/docs', 'main')).resolves.toBe('head-sha');
    expect(octokit.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/branches/{branch}', {
      owner: 'acme',
      repo: 'docs',
      branch: 'main',
    });
  });

  it('getRecursiveTree asks for the recursive tree at the pinned commit', async () => {
    const entries = [{ path: 'a.md', mode: '100644', type: 'blob', sha: 's1', size: 3 }];
    const octokit = octokitWith({ truncated: false, tree: entries });
    await expect(getRecursiveTree(octokit as never, 'acme/docs', 'c1')).resolves.toEqual({ truncated: false, entries });
    expect(octokit.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      owner: 'acme',
      repo: 'docs',
      tree_sha: 'c1',
      recursive: 'true',
    });
  });

  it('getBlobBytes decodes base64 content, embedded newlines included', async () => {
    const octokit = octokitWith({ content: 'aGVs\nbG8=\n', encoding: 'base64' });
    await expect(getBlobBytes(octokit as never, 'acme/docs', 's1')).resolves.toEqual(Buffer.from('hello'));
  });
});

describe('gitHubErrorStatus', () => {
  it.each([
    [Object.assign(new Error('x'), { status: 404 }), 404],
    [new Error('plain'), undefined],
    ['not an object', undefined],
    [null, undefined],
  ])('%o -> %s', (error, status) => {
    expect(gitHubErrorStatus(error)).toBe(status);
  });
});

describe('gitHubRateLimitDelaySeconds', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const nowSeconds = now / 1000;
  const httpError = (status: number, headers: Record<string, string>) =>
    Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });

  it('waits until the primary limit resets', () => {
    const error = httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowSeconds + 120) });
    expect(gitHubRateLimitDelaySeconds(error, now)).toBe(120);
  });

  it('caps the wait at the 900 s SQS delay ceiling, so a longer wait chains', () => {
    const error = httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowSeconds + 7200) });
    expect(gitHubRateLimitDelaySeconds(error, now)).toBe(900);
  });

  it('honors retry-after on a secondary limit even with quota remaining', () => {
    expect(
      gitHubRateLimitDelaySeconds(httpError(403, { 'retry-after': '60', 'x-ratelimit-remaining': '12' }), now)
    ).toBe(60);
    expect(gitHubRateLimitDelaySeconds(httpError(429, { 'retry-after': '30' }), now)).toBe(30);
  });

  it('honors an HTTP-date retry-after header', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const retryAt = new Date(now + 45_000).toUTCString();
      expect(gitHubRateLimitDelaySeconds(httpError(429, { 'retry-after': retryAt }), now)).toBe(45);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to 60 s when the reset is missing or already past, so deferrals do not burn in seconds', () => {
    expect(gitHubRateLimitDelaySeconds(httpError(403, { 'x-ratelimit-remaining': '0' }), now)).toBe(60);
    const past = httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowSeconds - 5) });
    expect(gitHubRateLimitDelaySeconds(past, now)).toBe(60);
    expect(gitHubRateLimitDelaySeconds(httpError(429, {}), now)).toBe(60);
  });

  it('is null for errors that are not rate limits', () => {
    expect(gitHubRateLimitDelaySeconds(httpError(403, { 'x-ratelimit-remaining': '12' }), now)).toBeNull();
    expect(gitHubRateLimitDelaySeconds(httpError(404, {}), now)).toBeNull();
    expect(gitHubRateLimitDelaySeconds(new Error('network'), now)).toBeNull();
  });
});
