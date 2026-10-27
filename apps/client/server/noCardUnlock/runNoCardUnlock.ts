import { McpServerName, type NoCardUnlockReason } from '@bike4mind/common';
import {
  adminSettingsRepository,
  cacheRepository,
  creditTransactionRepository,
  githubUnlockClaimRepository,
  mcpServerRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { decryptEnvVariables } from '@bike4mind/server-utils/security/tokenEncryption';
import { userService } from '@bike4mind/services';

const { GithubApiError, githubValidator, grantNoCardUnlock, loadNoCardUnlockSettings, workEmailValidator } =
  userService;
type GithubClient = userService.GithubClient;
type NoCardUnlockValidator = userService.NoCardUnlockValidator;

const GITHUB_TIMEOUT_MS = 8000;

async function githubGet<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new GithubApiError(response.status);
  return (await response.json()) as T;
}

const githubClient: GithubClient = {
  getUser: token => githubGet('/user', token),
  getEmails: token => githubGet('/user/emails', token),
};

async function getGithubAccessToken(userId: string): Promise<string | null> {
  const server = await mcpServerRepository.findOne({ userId, name: McpServerName.Github });
  if (!server || !server.enabled) return null;
  const tokenVar = decryptEnvVariables(server.envVariables, server).find(env => env.key === 'GITHUB_ACCESS_TOKEN');
  return tokenVar?.value || null;
}

export interface NoCardUnlockResponse {
  creditsGranted: number;
  currentCredits: number;
  refusal?: string;
}

export async function runNoCardUnlock(reason: NoCardUnlockReason, userId: string): Promise<NoCardUnlockResponse> {
  const settings = await loadNoCardUnlockSettings(adminSettingsRepository);

  const validators: Record<NoCardUnlockReason, NoCardUnlockValidator> = {
    github_verified: githubValidator({
      settings,
      github: githubClient,
      getAccessToken: getGithubAccessToken,
      claimGithubId: (githubId, id) => githubUnlockClaimRepository.claim(githubId, id),
    }),
    work_email_verified: workEmailValidator({
      settings,
      cache: cacheRepository,
      // Port 25 is blocked from the serverless runtime, so the probe is always inconclusive.
      catchAllProbe: async () => null,
    }),
  };

  const result = await grantNoCardUnlock(userId, reason, {
    db: {
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      users: userRepository,
    },
    validators,
    withTransaction,
  });

  if (result.granted) {
    return { creditsGranted: result.credits, currentCredits: result.currentCredits };
  }
  const user = await userRepository.findById(userId);
  return { creditsGranted: 0, currentCredits: user?.currentCredits ?? 0, refusal: result.refusal };
}
