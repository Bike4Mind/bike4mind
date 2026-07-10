/**
 * SRE Webhook Dispatch - Shared Logic
 *
 * Extracted from IssuesHandler.dispatchToSreIfMatching() so both the
 * org-level webhook flow and the dedicated /api/webhooks/github/sre
 * endpoint can reuse the same config check -> label filter -> SQS dispatch logic.
 */

import { Logger } from '@bike4mind/observability';
import {
  SreSourceType,
  SreClassification,
  SreEventPayload,
  SreAgentConfig,
  getConfiguredRepoSlugs,
  resolveFullConfig,
  SRE_DEFAULT_REPO_SLUG,
  type SreJobType,
} from '@bike4mind/common';
import { adminSettingsRepository, cacheRepository, sreErrorTrackingRepository } from '@bike4mind/database';
import { createHash } from 'crypto';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { sendToQueue } from '@server/utils/sqs';
import { z } from 'zod';

/** Dedup window for fingerprint-based dispatch dedup (1 hour, matches delivery-level dedup). */
const SRE_FINGERPRINT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Issue actions that should trigger SRE dispatch.
 *
 * Webhook actions (from GitHub):
 *   - `opened`   - new issue arrived; primary entry point
 *   - `labeled`  - `bug` (or other trigger label) was added to an existing issue
 *   - `reopened` - issue was reopened after being closed. A reopen
 *                  after an SRE-merged fix is the strongest "fix didn't work"
 *                  signal we have; the fix-loop guard in `sreAnalysis.ts`
 *                  detects the recent fix on the same fingerprint and escalates
 *                  to a human via Slack + GH comment. Human-driven reopens of
 *                  stale issues are accepted as noise - the recurrence path
 *                  produces a clear "Fix Loop Detected" message that operators
 *                  can dismiss if unwarranted.
 *
 * Synthetic actions (from internal admin/trigger endpoints):
 *   - `manual-trigger` - `/api/sre/trigger` (manual injection)
 *   - `retry`          - `/api/sre/tracking/:id/retry`
 *   - `rerun`          - `/api/sre/tracking/:id/rerun`
 *
 * Other webhook actions - notably `closed` - must never be ingested: when an
 * SRE-created PR merges and closes the source issue, the resulting `closed`
 * event would otherwise re-enter the pipeline, match the recent fix's
 * fingerprint, and trigger a false-positive "Fix Loop Detected" alert.
 */
const SRE_ELIGIBLE_ISSUE_ACTIONS = new Set(['opened', 'labeled', 'reopened', 'manual-trigger', 'retry', 'rerun']);

/**
 * Zod schema for validating the GitHub issue payload fields we depend on.
 * Used at the trust boundary (webhook endpoint) to catch shape mismatches
 * before they cause undefined-field errors deep in the dispatch logic.
 */
/**
 * `action` is deliberately typed as `z.string()` rather than `z.enum([...])`.
 *
 * Tightening to an enum would push action gating into schema validation, but
 * the webhook handler logs schema-parse failures at WARN level. Since GitHub
 * fires `issues` events for many actions we deliberately ignore (`closed`,
 * `unlabeled`, `edited`, `assigned`, ...), every closed/edited/etc. issue on a
 * configured repo - including every SRE PR merge - would generate a warn log,
 * spamming the channel where genuine "malformed payload" warnings live.
 *
 * Instead, gating happens at runtime inside `dispatchIssueToSre` via
 * `SRE_ELIGIBLE_ISSUE_ACTIONS`, which logs at INFO level and returns a
 * structured `reason` code. This also lets the same allowlist serve synthetic
 * admin actions (`manual-trigger`, `retry`, `rerun`) that bypass the schema.
 */
export const SreIssuePayloadSchema = z.object({
  action: z.string(),
  issue: z.object({
    title: z.string(),
    number: z.number(),
    html_url: z.string(),
    body: z.string().nullish(),
    labels: z.array(z.object({ name: z.string() })).optional(),
  }),
  repository: z.object({ full_name: z.string() }).optional(),
});

export type SreIssuePayload = z.infer<typeof SreIssuePayloadSchema>;

/**
 * Compute a deterministic fingerprint from an issue title.
 * Shared across dispatch, retry, and manual trigger to avoid drift.
 */
export function computeIssueFingerprint(title: string): string {
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(normalizedTitle).digest('hex');
}

/**
 * Extract a GitHub issue number from a URL of the form
 * "https://github.com/<owner>/<repo>/issues/<number>".
 * Used as a fallback for stale tracking docs missing githubIssueNumber.
 */
export function parseIssueNumberFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = url.match(/\/issues\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Denormalize a GitHub issue's open/closed state onto any SRE tracking docs for
 * that issue when a webhook reports the issue was closed or reopened.
 *
 * This is the authoritative freshness source for `githubIssueState`: GitHub fires
 * `issues.closed`/`issues.reopened` whenever an issue changes state - whether SRE
 * merged a fix (`Closes #N`), a human resolved it, or the bot closed it as
 * `already_fixed` - so a single touchpoint keeps the admin "hide closed-issue
 * tracking" filter accurate regardless of who closed the issue.
 *
 * Deliberately decoupled from `dispatchIssueToSre`'s eligibility gate: `closed`
 * is intentionally NOT an SRE-eligible action (re-ingesting it would trigger a
 * false-positive fix-loop alert), but we still want to record the state change.
 *
 * No-ops for any action other than `closed`/`reopened`, and swallows its own
 * errors: a failed state write must never fail the webhook (GitHub would retry
 * the delivery and re-dispatch the issue for analysis).
 *
 * Callable with either the loose `SreIssuePayload` (SRE endpoint) or the org
 * webhook's `GitHubIssuesPayload` - both satisfy this structural shape.
 */
export async function syncSreIssueStateFromWebhook(
  payload: { action: string; issue: { number: number }; repository?: { full_name?: string } },
  logger?: Logger
): Promise<void> {
  const state = payload.action === 'closed' ? 'closed' : payload.action === 'reopened' ? 'open' : undefined;
  if (!state) return;

  const repoSlug = payload.repository?.full_name;
  if (!repoSlug) return;

  try {
    const updated = await sreErrorTrackingRepository.setGithubIssueState(repoSlug, payload.issue.number, state);
    if (updated > 0) {
      logger?.info('[SRE-SENTINEL] Synced githubIssueState from webhook', {
        action: payload.action,
        issueNumber: payload.issue.number,
        repoSlug,
        state,
        updated,
      });
    }
  } catch (error) {
    logger?.warn('[SRE-SENTINEL] Failed to sync githubIssueState (non-fatal)', {
      action: payload.action,
      issueNumber: payload.issue.number,
      repoSlug,
      error,
    });
  }
}

export interface SreDispatchResult {
  dispatched: boolean;
  reason?: string;
}

/**
 * Check if issue labels match the SRE label filter configuration.
 * All required labels must be present, and at least one anyOf label (if specified).
 */
export function matchesLabelFilter(labels: string[], filter: { required: string[]; anyOf: string[] }): boolean {
  const hasAllRequired = filter.required.every(r => labels.includes(r));
  const hasAnyOf = filter.anyOf.length === 0 || filter.anyOf.some(a => labels.includes(a));
  return hasAllRequired && hasAnyOf;
}

/**
 * Dispatch a GitHub issue to the SRE analysis queue if it matches
 * the configured filters. Loads config from adminSettings.
 *
 * @param payload - Normalized issue payload (from webhook or handler)
 * @param logger - Optional logger instance
 * @param correlationId - Optional correlation ID for distributed tracing
 */
export async function dispatchIssueToSre(
  payload: SreIssuePayload,
  logger?: Logger,
  correlationId?: string
): Promise<SreDispatchResult> {
  // Action allowlist - the single gate for both webhook callers (where the
  // schema deliberately stays loose, see SreIssuePayloadSchema docblock) and
  // synthetic admin callers (`manual-trigger`, `retry`, `rerun`). Skipping this
  // check causes a false-positive fix-loop alert when an SRE PR merged and
  // closed the source issue.
  if (!SRE_ELIGIBLE_ISSUE_ACTIONS.has(payload.action)) {
    logger?.info('[SRE-SENTINEL] Issue action not eligible for SRE dispatch', {
      action: payload.action,
      issueNumber: payload.issue.number,
    });
    return { dispatched: false, reason: 'action-not-eligible' };
  }

  const sreConfig = (await adminSettingsRepository.getSettingsValue('sreAgentConfig')) as SreAgentConfig | undefined;
  if (!sreConfig) {
    return { dispatched: false, reason: 'pipeline-disabled' };
  }

  // Repo filter: only process issues from configured repos
  const repoSlug = payload.repository?.full_name || 'unknown';
  const configuredRepos = getConfiguredRepoSlugs(sreConfig);

  if (configuredRepos.length > 0 && !configuredRepos.includes(repoSlug)) {
    logger?.info('[SRE-SENTINEL] Issue repo not in configured repos, skipping', {
      issueRepo: repoSlug,
      configuredRepos,
    });
    return { dispatched: false, reason: 'repo-mismatch' };
  }

  // Resolve per-repo config for source checks and label filter
  const repoConfig = resolveFullConfig(sreConfig, repoSlug !== 'unknown' ? repoSlug : SRE_DEFAULT_REPO_SLUG);

  if (!repoConfig) {
    return { dispatched: false, reason: 'repo-not-configured' };
  }

  if (!repoConfig.enabled) {
    return { dispatched: false, reason: 'repo-disabled' };
  }

  if (!repoConfig.sources.github.enabled) {
    return { dispatched: false, reason: 'github-source-disabled' };
  }

  const issueLabels = (payload.issue.labels || []).map(l => l.name);
  if (!matchesLabelFilter(issueLabels, repoConfig.sources.github.labelFilter)) {
    logger?.info('[SRE-SENTINEL] Issue labels do not match SRE filter', {
      issueNumber: payload.issue.number,
      issueLabels,
      filter: repoConfig.sources.github.labelFilter,
    });
    return { dispatched: false, reason: 'label-mismatch' };
  }

  // Generate fingerprint from normalized issue title
  const fingerprint = computeIssueFingerprint(payload.issue.title);

  // Pass the original webhook action through to the analysis handler so it can
  // disambiguate fix-loop alerts. Synthetic admin actions (`manual-trigger`,
  // `retry`, `rerun`) don't map to a webhook action, so leave triggerAction
  // undefined for those - the analysis handler will fall back to the generic
  // recurrence message.
  const triggerAction: SreEventPayload['triggerAction'] | undefined =
    payload.action === 'opened' || payload.action === 'labeled' || payload.action === 'reopened'
      ? payload.action
      : undefined;

  const srePayload: SreEventPayload & { correlationId?: string } = {
    source: SreSourceType.GITHUB_ISSUE,
    fingerprint,
    repoSlug,
    classification: SreClassification.MEDIUM,
    errorMessage: payload.issue.title,
    stackTrace: payload.issue.body || undefined,
    issueNumber: payload.issue.number,
    issueUrl: payload.issue.html_url,
    labels: issueLabels,
    ...(triggerAction && { triggerAction }),
    ...(correlationId && { correlationId }),
  };

  if (repoConfig.dryRun) {
    logger?.info('[SRE-SENTINEL] [DRY-RUN] Dispatching to sreJobQueue with dryRun flag', {
      payload: srePayload,
    });
    srePayload.dryRun = true;
  }

  // Fingerprint-level dedup: prevents duplicate dispatch when the same issue
  // arrives via both the org webhook ([token].ts) and the SRE endpoint (sre.ts).
  // The delivery-level dedup in each endpoint only catches exact re-deliveries;
  // this catches the same logical issue entering through different paths.
  // Repo-scoped dedup key: same issue title in different repos should be dispatched independently
  const dedupKey = `sre-dispatch-${repoSlug}:${fingerprint}`;
  const dedupResult = await cacheRepository.incrementCounterConditional(dedupKey, 1, SRE_FINGERPRINT_DEDUP_WINDOW_MS);
  if (!dedupResult.success) {
    logger?.info('[SRE-SENTINEL] Issue already dispatched (fingerprint dedup)', {
      fingerprint,
      issueNumber: payload.issue.number,
    });
    return { dispatched: false, reason: 'already-dispatched' };
  }

  await sendToQueue(getSourceQueueUrl('sreJobQueue'), {
    ...srePayload,
    jobType: 'analysis' satisfies SreJobType,
  } as unknown as Record<string, unknown>);
  logger?.info('[SRE-SENTINEL] Dispatched GitHub issue to sreJobQueue', {
    fingerprint,
    issueNumber: payload.issue.number,
    repoSlug,
    labels: issueLabels,
    correlationId,
  });

  return { dispatched: true };
}
