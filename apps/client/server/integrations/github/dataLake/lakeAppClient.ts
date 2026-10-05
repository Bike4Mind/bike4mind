import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { parseRateLimitHeaders, resolveRetryAfterDelayMs } from '@bike4mind/common';
import { Config } from '@server/utils/config';
import type { GitHubTreeEntry } from './lakeFileFilter';

/**
 * Thin client for the read-only data-lake GitHub App (see infra/secrets.ts GITHUB_LAKE_APP_*).
 * Distinct from GitHubService, which authenticates the internal OrgGitHubConnection automation App.
 */

const USER_AGENT = 'bike4mind-datalake-github/1.0';
const GITHUB_REQUEST_TIMEOUT_MS = 10000; // fail before GitHub's ~11s gateway timeout, as GitHubService does
const UNSET_SECRET = 'not-configured';

export type GitHubLakeAppConfig = {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
};

export type GitHubLakeRepository = { id: number; fullName: string; defaultBranch: string; private: boolean };

export type GitHubLakeInstallation = {
  id: number;
  accountLogin: string;
  repositorySelection: 'all' | 'selected';
  permissions: Record<string, string | undefined>;
};

/** An installation as the user's own token sees it: GET /user/installations. */
export type GitHubLakeUserInstallation = GitHubLakeInstallation & {
  /** The account's numeric GitHub id - the `target_id` of a targeted install link. Null without an account. */
  accountId: number | null;
  accountType: 'User' | 'Organization';
  settingsUrl: string;
};

const isSet = (value: string | undefined): value is string => Boolean(value) && value !== UNSET_SECRET;

/** The App's credentials, or null when any is unprovisioned on this stage. */
export function getGitHubLakeAppConfig(): GitHubLakeAppConfig | null {
  const appId = Config.GITHUB_LAKE_APP_ID;
  const slug = Config.GITHUB_LAKE_APP_SLUG;
  const privateKey = Config.GITHUB_LAKE_APP_PRIVATE_KEY;
  const clientId = Config.GITHUB_LAKE_APP_CLIENT_ID;
  const clientSecret = Config.GITHUB_LAKE_APP_CLIENT_SECRET;
  if (!isSet(appId) || !isSet(slug) || !isSet(privateKey) || !isSet(clientId) || !isSet(clientSecret)) {
    return null;
  }
  // `sst secret set` flattens a PEM's newlines to literal \n unless it was set from a file.
  return { appId, slug, privateKey: privateKey.replace(/\\n/g, '\n'), clientId, clientSecret };
}

const isNotFound = (error: unknown): boolean => gitHubErrorStatus(error) === 404;

function appOctokit(config: GitHubLakeAppConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
    userAgent: USER_AGENT,
    request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
  });
}

function tokenOctokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: USER_AGENT, request: { timeout: GITHUB_REQUEST_TIMEOUT_MS } });
}

/** Exchanges the `code` GitHub returns from the App's OAuth authorize (or user authorization on install) for a user token. */
export async function exchangeInstallerCode(config: GitHubLakeAppConfig, code: string): Promise<string> {
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  const { token } = await auth({ type: 'oauth-user', code });
  return token;
}

/**
 * The installation's repositories that the token's user can access, or null when the user cannot
 * access the installation at all. This is the ownership proof: an installation id in a callback is
 * caller-supplied, and only the installer (or a member who can see it) gets a list back.
 */
export async function listInstallerVisibleRepositories(
  userToken: string,
  installationId: number
): Promise<GitHubLakeRepository[] | null> {
  try {
    const repositories = await tokenOctokit(userToken).paginate(
      'GET /user/installations/{installation_id}/repositories',
      { installation_id: installationId, per_page: 100 }
    );
    return repositories.map(repo => ({
      id: repo.id,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
    }));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * The App's installations the token's user can access: their own account's, and an org's when they
 * are a member of it (not only its owners).
 */
export async function listUserInstallations(userToken: string): Promise<GitHubLakeUserInstallation[]> {
  const installations = await tokenOctokit(userToken).paginate('GET /user/installations', { per_page: 100 });
  return installations.map(installation => {
    const account = installation.account;
    const isUser = account !== null && 'login' in account && account.type === 'User';
    return {
      id: installation.id,
      accountLogin: account && 'login' in account ? account.login : (account?.slug ?? ''),
      accountId: account?.id ?? null,
      accountType: isUser ? 'User' : 'Organization',
      settingsUrl: installation.html_url,
      repositorySelection: installation.repository_selection,
      permissions: { ...installation.permissions },
    };
  });
}

/** Revokes a user token once its flow is done with it; only its ciphertext is ever stored (GitHubLakeAuthGrant). */
export async function revokeInstallerToken(config: GitHubLakeAppConfig, userToken: string): Promise<void> {
  await appOctokit(config).request('DELETE /applications/{client_id}/token', {
    client_id: config.clientId,
    access_token: userToken,
  });
}

export async function getInstallation(
  config: GitHubLakeAppConfig,
  installationId: number
): Promise<GitHubLakeInstallation> {
  const { data } = await appOctokit(config).request('GET /app/installations/{installation_id}', {
    installation_id: installationId,
  });
  const account = data.account;
  const accountLogin = account && 'login' in account ? account.login : (account?.slug ?? '');
  return {
    id: data.id,
    accountLogin,
    repositorySelection: data.repository_selection,
    permissions: { ...data.permissions },
  };
}

/** Uninstalls the App from the account. An installation that is already gone counts as removed. */
export async function deleteInstallation(config: GitHubLakeAppConfig, installationId: number): Promise<void> {
  try {
    await appOctokit(config).request('DELETE /app/installations/{installation_id}', {
      installation_id: installationId,
    });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

const MAX_SQS_DELAY_SECONDS = 900;
const RATE_LIMIT_FALLBACK_SECONDS = 60;

const splitFullName = (fullName: string) => {
  const [owner, repo] = fullName.split('/');
  return { owner, repo };
};

/** A token scoped to the one bound repository, so an installation that can see more cannot feed them in. */
export async function getInstallationOctokit(
  config: GitHubLakeAppConfig,
  installationId: number,
  repositoryId: number
): Promise<Octokit> {
  const auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey });
  const { token } = await auth({ type: 'installation', installationId, repositoryIds: [repositoryId] });
  return tokenOctokit(token);
}

/** GitHub redirects a renamed or transferred repository, so the stored name still resolves; the id check is the guard. */
export async function getRepository(
  octokit: Octokit,
  fullName: string,
  repositoryId: number
): Promise<{ fullName: string; defaultBranch: string }> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}', splitFullName(fullName));
  if (data.id !== repositoryId) {
    throw Object.assign(new Error('The stored repository name now resolves to a different repository'), {
      status: 404,
    });
  }
  return { fullName: data.full_name, defaultBranch: data.default_branch };
}

export async function getBranchHeadSha(octokit: Octokit, fullName: string, branch: string): Promise<string> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
    ...splitFullName(fullName),
    branch,
  });
  return data.commit.sha;
}

export async function getRecursiveTree(
  octokit: Octokit,
  fullName: string,
  commitSha: string
): Promise<{ truncated: boolean; entries: GitHubTreeEntry[] }> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    ...splitFullName(fullName),
    tree_sha: commitSha,
    recursive: 'true',
  });
  return { truncated: data.truncated, entries: data.tree };
}

export async function getBlobBytes(octokit: Octokit, fullName: string, blobSha: string): Promise<Buffer> {
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
    ...splitFullName(fullName),
    file_sha: blobSha,
  });
  return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8');
}

export function gitHubErrorStatus(error: unknown): number | undefined {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}

/** Seconds to wait out a GitHub rate limit, capped at the SQS delay ceiling; null when the error is not one. */
export function gitHubRateLimitDelaySeconds(error: unknown, nowMs: number): number | null {
  const status = gitHubErrorStatus(error);
  if (status !== 403 && status !== 429) return null;
  const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers ?? {};
  const info = parseRateLimitHeaders(headers);
  const hasRetryAfter = info.retryAfterMs !== null && info.retryAfterMs > 0;
  // A 403 is only a throttle when the budget is actually exhausted (or the response itself asked us
  // to wait); otherwise it's a permissions error and must not be reported as "retry later".
  if (!hasRetryAfter && status === 403 && info.remaining !== 0) return null;
  const untilResetMs = info.resetAt ? info.resetAt.getTime() - nowMs : NaN;
  // A missing or already-passed reset still needs a real wait, or the deferral budget burns in seconds.
  const fallbackMs =
    Number.isFinite(untilResetMs) && untilResetMs > 0 ? untilResetMs : RATE_LIMIT_FALLBACK_SECONDS * 1000;
  const delayMs = resolveRetryAfterDelayMs(info, fallbackMs);
  return Math.min(Math.ceil(delayMs / 1000), MAX_SQS_DELAY_SECONDS);
}
