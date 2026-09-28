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

import {
  getGitHubLakeAppConfig,
  deleteInstallation,
  listInstallerVisibleRepositories,
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
