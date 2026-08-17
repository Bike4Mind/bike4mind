/**
 * PR report generator - composition root.
 *
 * Resolves the admin-editable settings and the managed credentials, then assembles
 * the dependency bundles the two endpoints hand to the core service.
 *
 * Credential rules honored here:
 *   - the GitHub token is resolved inside GitHubService (App, else service-account
 *     PAT), never read from the environment by this capability;
 *   - the send credential is the Slack Incoming Webhook URL (`prReportWebhookUrl`), a
 *     bearer-equivalent secret stored encrypted; it is masked on every settings read and
 *     its absence yields a clean `targetRejected` rather than a fallback;
 *   - the workspace bot token is OPTIONAL and used only for the proofreading preview's
 *     member-name lookup (a read scope the webhook does not carry); its absence just
 *     degrades the preview to raw member ids.
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
  /** Null when no webhook URL is configured - send then fails closed. */
  destination: prReportService.ChatPostTarget | null;
  allowedEgressHosts: string[];
  /** Errors from the free-text identity map, surfaced to the admin UI. */
  identityMapErrors: prReportService.ParsedIdentityMapResult['errors'];
  /** Structural spec misconfigurations that must BLOCK the generate. */
  specErrors: prReportService.BucketSpecValidationError[];
  /**
   * Non-blocking spec advisories - today, roster role keys with no identity-map entry.
   * The digest still renders (the pool mention is simply omitted); surfaced to the UI
   * so the admin knows which pools will not be pinged.
   */
  rosterWarnings: prReportService.BucketSpecValidationError[];
}

/**
 * Read everything the capability needs. Never returns the Slack token to a caller
 * that only wants config - `destination` is consumed server-side by the send path.
 */
export async function loadPrReportConfig(): Promise<PrReportConfig> {
  const [repo, identityMapRaw, webhookUrl, egress] = await Promise.all([
    adminSettingsRepository.getSettingsValue('prReportRepo'),
    adminSettingsRepository.getSettingsValue('prReportIdentityMap'),
    adminSettingsRepository.getSettingsValue('prReportWebhookUrl'),
    adminSettingsRepository.getSettingsValue('prReportEgressAllowlist'),
  ]);

  const parsed = prReportService.parseIdentityMap(identityMapRaw ?? '');
  const identityLookup = parsed.entries.reduce<prReportService.IdentityLookup>((lookup, entry) => {
    lookup[entry.key] = entry.memberId;
    return lookup;
  }, {});

  const bucketSpecs = prReportService.BUCKET_SPECS;

  // The webhook URL is the whole send credential - it encodes channel and workspace,
  // so no bot token is resolved here. Its format and host are checked by the egress
  // guard at send time, not here.
  const destination: prReportService.ChatPostTarget | null = webhookUrl ? { webhookUrl } : null;

  // Validated here rather than only at settings-save, so a boot with a typo'd role key
  // is visible. Split by severity: structural errors block the generate; a roster whose
  // role key is unmapped is advisory (the renderer omits the pool mention safely).
  const specValidation = prReportService.validateBucketSpecs(bucketSpecs, identityLookup);

  return {
    repo: repo ?? '',
    identityLookup,
    bucketSpecs,
    destination,
    allowedEgressHosts: egress?.hosts ?? [],
    identityMapErrors: parsed.errors,
    specErrors: specValidation.filter(error => error.severity === 'blocking'),
    rosterWarnings: specValidation.filter(error => error.severity === 'advisory'),
  };
}

/**
 * The Slack bot token, from the first active workspace record.
 *
 * OPTIONAL and read-only: it is used only by the proofreading preview's member-name
 * lookup, never to post (the webhook URL is the send credential). Its absence just
 * degrades the preview to raw member ids - there is no environment fallback.
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
    // The member-name lookup needs a READ scope, which the send webhook does not carry;
    // it uses the optional workspace bot token instead. Resolved per-request so a rotated
    // token takes effect without a redeploy, and a null token degrades to raw ids.
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
