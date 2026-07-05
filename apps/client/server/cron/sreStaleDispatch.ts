/**
 * SRE Stale Dispatch Cleanup Cron
 *
 * Runs every 15 minutes to detect dispatches stuck in 'fixing' status.
 * A dispatch is considered stale if it's been 'fixing' for longer than
 * STALE_TIMEOUT_MINUTES without a callback from GitHub Actions.
 *
 * Uses atomicTransition (CAS) to prevent races with the Surgeon callback
 * that may have already transitioned fixing -> fixed.
 *
 * Schedule: Every 15 minutes
 * Environment: production, dev
 */

import { connectDB, sreErrorTrackingRepository, adminSettingsRepository } from '@bike4mind/database';
import {
  SreAgentConfigSchema,
  SRE_DEFAULT_REPO_SLUG,
  resolveFullConfig,
  getConfiguredRepoSlugs,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';
import { postSreTimeoutSummaryMessage } from '@server/integrations/slack/sreSlackApproval';

const logger = new Logger({ metadata: { service: 'sreStaleDispatch' } });

const STALE_TIMEOUT_MINUTES = 20;
const ANALYZING_TIMEOUT_MINUTES = 10;

export async function handler() {
  const stage = Resource.App.stage;

  logger.info('[SRE-STALE-DISPATCH] Starting stale dispatch cleanup', { stage });

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  let transitioned = 0;

  // Timeout stale 'fixing' docs (no callback from GitHub Actions)
  const stale = await sreErrorTrackingRepository.findStaleDispatches(STALE_TIMEOUT_MINUTES);
  for (const doc of stale) {
    try {
      // Use atomicTransition (CAS) instead of updateStatus to prevent race with
      // Surgeon callback that may have already transitioned fixing -> fixed.
      const result = await sreErrorTrackingRepository.atomicTransition(doc.id, 'fixing', 'failed', {
        errorMessage: `Fix dispatch timed out after ${STALE_TIMEOUT_MINUTES} minutes — no callback received from GitHub Actions`,
      });
      if (!result) continue; // Callback already transitioned it — skip
      transitioned++;
      logger.warn('[SRE-STALE-DISPATCH] Timed out', {
        trackingId: doc.id,
        fingerprint: doc.errorFingerprint,
      });
    } catch (error) {
      logger.error('[SRE-STALE-DISPATCH] Error transitioning', { trackingId: doc.id, error });
    }
  }

  // Timeout stale 'analyzing' docs (Lambda crash / timeout)
  const staleAnalyzing = await sreErrorTrackingRepository.findStaleByStatus('analyzing', ANALYZING_TIMEOUT_MINUTES);
  for (const doc of staleAnalyzing) {
    try {
      const result = await sreErrorTrackingRepository.atomicTransition(doc.id, 'analyzing', 'failed', {
        errorMessage: 'Analysis timed out — Lambda may have crashed',
      });
      if (result) {
        transitioned++;
        logger.warn('[SRE-STALE-DISPATCH] Analysis timed out', { trackingId: doc.id });
      }
    } catch (error) {
      logger.error('[SRE-STALE-DISPATCH] Error transitioning analyzing doc', { trackingId: doc.id, error });
    }
  }

  // Timeout stale 'revision_requested' docs (revision Lambda crash / timeout)
  const staleRevisions = await sreErrorTrackingRepository.findStaleByStatus(
    'revision_requested',
    ANALYZING_TIMEOUT_MINUTES
  );
  for (const doc of staleRevisions) {
    try {
      const result = await sreErrorTrackingRepository.atomicTransition(doc.id, 'revision_requested', 'failed', {
        errorMessage: 'Revision timed out — Lambda may have crashed',
      });
      if (result) {
        transitioned++;
        logger.warn('[SRE-STALE-DISPATCH] Revision timed out', { trackingId: doc.id });
      }
    } catch (error) {
      logger.error('[SRE-STALE-DISPATCH] Error transitioning revision doc', { trackingId: doc.id, error });
    }
  }

  // Timeout stale 'awaiting_approval' docs (approval never received)
  const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
  const sreConfig = SreAgentConfigSchema.parse(rawConfig ?? {});

  // Use the longest approval timeout across all configured repos to find candidates,
  // Use the SHORTEST timeout to ensure all repos' stale docs are returned.
  // The per-doc check below filters out docs that haven't exceeded their
  // repo-specific timeout yet.
  const configuredRepos = getConfiguredRepoSlugs(sreConfig);
  const repoTimeouts = configuredRepos
    .map(slug => resolveFullConfig(sreConfig, slug))
    .filter(Boolean)
    .map(rc => rc!.gates.diagnosticianToSurgeon.approvalTimeoutHours * 60);
  const minTimeoutMinutes = repoTimeouts.length > 0 ? Math.min(...repoTimeouts) : 12 * 60;

  const staleApprovals = await sreErrorTrackingRepository.findStaleByStatus('awaiting_approval', minTimeoutMinutes);
  for (const doc of staleApprovals) {
    try {
      // Resolve per-repo config for this doc's approval timeout
      const docRepoSlug = doc.repoSlug ?? SRE_DEFAULT_REPO_SLUG;
      const docRepoConfig = resolveFullConfig(sreConfig, docRepoSlug);
      if (!docRepoConfig) continue; // Repo no longer configured — skip
      const docTimeoutHours = docRepoConfig.gates.diagnosticianToSurgeon.approvalTimeoutHours;
      const docTimeoutMs = docTimeoutHours * 60 * 60 * 1000;

      // Check if this specific doc has actually exceeded its per-repo timeout
      const docAge = Date.now() - new Date(doc.updatedAt).getTime();
      if (docAge < docTimeoutMs) continue;

      const result = await sreErrorTrackingRepository.atomicTransition(
        doc.id,
        'awaiting_approval',
        'approval_expired',
        {
          errorMessage: `Approval timed out after ${docTimeoutHours}h`,
        }
      );
      if (result) {
        transitioned++;
        logger.warn('[SRE-STALE-DISPATCH] Approval timed out', { trackingId: doc.id });
      }
    } catch (error) {
      logger.error('[SRE-STALE-DISPATCH] Error transitioning approval doc', { trackingId: doc.id, error });
    }
  }

  const totalChecked = stale.length + staleAnalyzing.length + staleRevisions.length + staleApprovals.length;
  logger.info('[SRE-STALE-DISPATCH] Cleanup complete', { transitioned, totalChecked });

  if (transitioned > 0) {
    try {
      // Use first configured repo's slack config for the summary notification
      const summaryRepoSlug = getConfiguredRepoSlugs(sreConfig)[0] ?? SRE_DEFAULT_REPO_SLUG;
      const summaryRepoConfig = resolveFullConfig(sreConfig, summaryRepoSlug);
      if (summaryRepoConfig) {
        await postSreTimeoutSummaryMessage(transitioned, totalChecked, summaryRepoConfig.slack ?? {});
      }
    } catch (slackError) {
      logger.error('[SRE-STALE-DISPATCH] Failed to send Slack timeout summary (non-fatal)', { error: slackError });
    }
  }

  return { status: 'OK', transitioned, totalChecked };
}
