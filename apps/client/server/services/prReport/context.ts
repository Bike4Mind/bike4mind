/**
 * PR report generator - composition root.
 *
 * Resolves the admin-editable settings and the managed credentials, then assembles
 * the dependency bundles the two endpoints hand to the core service.
 *
 * Credential rules honored here:
 *   - the GitHub token is resolved inside GitHubService (App, else service-account
 *     PAT), never read from the environment by this capability;
 *   - the Slack bot token comes from the encrypted workspace record and is
 *     bearer-equivalent: it is never returned by any settings read, never sent to the
 *     client, and its absence yields a clean `targetRejected` rather than a fallback.
 */

import { adminSettingsRepository, slackDevWorkspaceRepository } from '@bike4mind/database';
import { prReportService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { decryptToken } from '@server/security/tokenEncryption';

import { assertRepoFormat, createAssertChatTargetFormat } from './guards';
import { createFetchApprovedPrNumbers, createFetchOpenPullRequests } from './githubPrSource';
import { createFetchChatMemberNames, createPostReport } from './slackChatTarget';
import { createSendDedupeStore } from './dedupeStore';
import { createPrReportMetrics } from './metrics';

export interface PrReportConfig {
  repo: string;
  identityLookup: prReportService.IdentityLookup;
  bucketSpecs: prReportService.BucketSpecs;
  /** Null when no Slack workspace/channel is configured - send then fails closed. */
  destination: prReportService.ChatPostTarget | null;
  allowedEgressHosts: string[];
  /** Errors from the free-text identity map, surfaced to the admin UI. */
  identityMapErrors: prReportService.ParsedIdentityMapResult['errors'];
  /** Spec/identity misconfigurations that must block a save or a boot. */
  specErrors: prReportService.BucketSpecValidationError[];
}

/**
 * Read everything the capability needs. Never returns the Slack token to a caller
 * that only wants config - `destination` is consumed server-side by the send path.
 */
export async function loadPrReportConfig(): Promise<PrReportConfig> {
  const [repo, identityMapRaw, channel, egress] = await Promise.all([
    adminSettingsRepository.getSettingsValue('prReportRepo'),
    adminSettingsRepository.getSettingsValue('prReportIdentityMap'),
    adminSettingsRepository.getSettingsValue('prReportSlackChannel'),
    adminSettingsRepository.getSettingsValue('prReportEgressAllowlist'),
  ]);

  const parsed = prReportService.parseIdentityMap(identityMapRaw ?? '');
  const identityLookup = parsed.entries.reduce<prReportService.IdentityLookup>((lookup, entry) => {
    lookup[entry.key] = entry.memberId;
    return lookup;
  }, {});

  const bucketSpecs = prReportService.BUCKET_SPECS;

  let destination: prReportService.ChatPostTarget | null = null;
  if (channel) {
    const token = await resolveSlackBotToken();
    if (token) destination = { token, channel };
  }

  return {
    repo: repo ?? '',
    identityLookup,
    bucketSpecs,
    destination,
    allowedEgressHosts: egress?.hosts ?? [],
    identityMapErrors: parsed.errors,
    // Validated here rather than only at settings-save, so a boot with a typo'd role
    // key is visible: both failure modes this catches are silent and daily otherwise.
    specErrors: prReportService.validateBucketSpecs(bucketSpecs, identityLookup),
  };
}

/**
 * The Slack bot token, from the first active workspace record.
 *
 * Precedence is deliberate and shallow: the workspace credential, else nothing. There
 * is no environment fallback and no hard-coded default - a missing credential must
 * surface as a configuration error, not as a post to somewhere unexpected.
 */
async function resolveSlackBotToken(): Promise<string | null> {
  const workspaces = await slackDevWorkspaceRepository.findAllActiveWithCredentials();
  const withToken = workspaces.find(workspace => !!workspace.slackBotToken);
  if (!withToken?.slackBotToken) return null;
  return decryptToken(withToken.slackBotToken);
}

export function createGenerateDeps(logger: Logger): prReportService.GenerateReportDeps {
  return {
    fetchOpenPullRequests: createFetchOpenPullRequests(logger),
    fetchApprovedPrNumbers: createFetchApprovedPrNumbers(logger),
    // The member-name lookup needs a READ scope on the same credential that posts.
    // Resolved per-request so a rotated token takes effect without a redeploy.
    fetchChatMemberNames: async memberIds => {
      const token = await resolveSlackBotToken();
      return createFetchChatMemberNames(logger, token)(memberIds);
    },
    assertRepoFormat,
    metrics: createPrReportMetrics(logger),
  };
}

export function createSendDeps(logger: Logger, config: PrReportConfig): prReportService.SendReportDeps {
  return {
    postReport: createPostReport(logger),
    assertChatTargetFormat: createAssertChatTargetFormat({ allowedHosts: config.allowedEgressHosts }),
    dedupeStore: createSendDedupeStore(),
    metrics: createPrReportMetrics(logger),
  };
}
