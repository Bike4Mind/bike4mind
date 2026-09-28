import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { Config } from '@server/utils/config';

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

export type GitHubLakeRepository = { id: number; fullName: string };

export type GitHubLakeInstallation = {
  id: number;
  accountLogin: string;
  repositorySelection: 'all' | 'selected';
  permissions: Record<string, string | undefined>;
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

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404;

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

function userOctokit(userToken: string): Octokit {
  return new Octokit({ auth: userToken, userAgent: USER_AGENT, request: { timeout: GITHUB_REQUEST_TIMEOUT_MS } });
}

/** Exchanges the `code` GitHub returns after install (user authorization on install) for a user token. */
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
    const repositories = await userOctokit(userToken).paginate(
      'GET /user/installations/{installation_id}/repositories',
      { installation_id: installationId, per_page: 100 }
    );
    return repositories.map(repo => ({ id: repo.id, fullName: repo.full_name }));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Revokes a user token minted only to verify an installation; it is never stored. */
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
