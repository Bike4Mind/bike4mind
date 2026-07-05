/**
 * SRE Slack Approval Utilities
 *
 * Handles posting approval messages and processing approve/reject button clicks
 * for the SRE Agent Trio's confidence-based gate logic.
 *
 * Uses the OAuth-installed Slack workspace (bot token) rather than incoming webhooks,
 * matching the pattern used by Context Telemetry Alerts and LiveOps Triage.
 */

import { Logger } from '@bike4mind/observability';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { sendToQueue } from '@server/utils/sqs';
import { adminSettingsRepository, sreErrorTrackingRepository, slackDevWorkspaceRepository } from '@bike4mind/database';
import {
  SreAgentConfigSchema,
  SreFixRequest,
  SreSourceType,
  SRE_DEFAULT_REPO_SLUG,
  resolveFullConfig,
} from '@bike4mind/common';
import type { KnownBlock } from '@slack/web-api';
import { WebClient } from '@slack/web-api';

const logger = new Logger();

/** Escape Slack mrkdwn control characters in untrusted text */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format a source reference for Slack mrkdwn - link if URL, backtick-escaped otherwise */
function formatSourceRef(sourceRef: string): string {
  if (sourceRef.startsWith('https://')) {
    // Strip >, |, and newlines to prevent Slack mrkdwn injection (defense-in-depth; values are server-constructed)
    const sanitized = sourceRef.replace(/[>|\r\n]/g, '');
    return `<${sanitized}>`;
  }
  return `\`${sourceRef}\``;
}

/** Resolve workspace bot token, returning null if not configured */
async function resolveWorkspace(
  slackConfig: { workspaceId?: string; channelId?: string },
  context: string
): Promise<{ client: WebClient; channelId: string } | null> {
  if (!slackConfig.workspaceId || !slackConfig.channelId) {
    logger.warn(`[SRE-SLACK] Slack workspace or channel not configured, skipping ${context}`);
    return null;
  }

  const workspace = await slackDevWorkspaceRepository.findByIdWithToken(slackConfig.workspaceId);
  if (!workspace?.slackBotToken) {
    logger.warn('[SRE-SLACK] Workspace not found or missing bot token', {
      workspaceId: slackConfig.workspaceId,
    });
    return null;
  }

  return { client: new WebClient(workspace.slackBotToken), channelId: slackConfig.channelId };
}

/** Post blocks to Slack, logging errors without throwing */
async function postBlocks(
  client: WebClient,
  channelId: string,
  fallbackText: string,
  blocks: KnownBlock[],
  context: string
): Promise<void> {
  try {
    const result = await client.chat.postMessage({ channel: channelId, text: fallbackText, blocks });
    if (!result.ok) {
      logger.error(`[SRE-SLACK] Failed to post ${context}`, { error: result.error });
    }
  } catch (error) {
    logger.error(`[SRE-SLACK] Error posting ${context}`, { error });
  }
}

/**
 * Post an SRE approval request to Slack with Approve/Reject buttons.
 * Uses the configured workspace bot token + channel ID.
 */
export async function postSreApprovalMessage(
  trackingId: string,
  diagnosis: {
    rootCause: string;
    proposedFix: string;
    confidence: number;
    riskAssessment: string;
    affectedFiles: Array<{ filePath: string }>;
  },
  errorMessage: string,
  fingerprint: string,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'approval message');
  if (!ws) return;

  const fileList = diagnosis.affectedFiles.map(f => `\`${escapeSlackMrkdwn(f.filePath)}\``).join(', ');

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Fix Approval Needed', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Confidence:* ${diagnosis.confidence}%` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Risk:* ${escapeSlackMrkdwn(diagnosis.riskAssessment.slice(0, 200))}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Root Cause:* ${escapeSlackMrkdwn(diagnosis.rootCause.slice(0, 500))}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Proposed Fix:* ${escapeSlackMrkdwn(diagnosis.proposedFix.slice(0, 500))}\n*Files:* ${fileList}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve Fix', emoji: true },
          style: 'primary',
          action_id: 'sre_approve_fix',
          value: trackingId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject', emoji: true },
          style: 'danger',
          action_id: 'sre_reject_fix',
          value: trackingId,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: Fix approval needed (confidence: ${diagnosis.confidence}%)`,
    blocks,
    'approval message'
  );
}

/**
 * Post an informational Slack message when a fix is scope-blocked.
 * No action buttons - informational only, with a hint to update config.
 */
export async function postSreScopeBlockedMessage(
  trackingId: string,
  diagnosis: {
    rootCause: string;
    confidence: number;
  },
  errorMessage: string,
  fingerprint: string,
  blockedFiles: string[],
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'scope-blocked message');
  if (!ws) return;

  const fileList = blockedFiles.map(f => `\`${f}\``).join('\n');

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Scope Blocked', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Confidence:* ${diagnosis.confidence}%` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Root Cause:* ${escapeSlackMrkdwn(diagnosis.rootCause.slice(0, 500))}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Blocked Files:*\n${fileList}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Update \`allowedFilePatterns\` in SRE config to unblock. Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    'SRE Agent: Fix scope-blocked — files outside allowed scope',
    blocks,
    'scope-blocked message'
  );
}

/**
 * Post an informational Slack message when diagnosis determines no code fix is needed.
 * No action buttons - informational only.
 */
export async function postSreNoFixNeededMessage(
  trackingId: string,
  diagnosis: { rootCause: string; proposedFix: string; confidence: number },
  errorMessage: string,
  fingerprint: string,
  sourceRef: string,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'no-fix-needed message');
  if (!ws) return;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — No Fix Needed', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Confidence:* ${diagnosis.confidence}%` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Root Cause:* ${escapeSlackMrkdwn(diagnosis.rootCause.slice(0, 500))}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reason:* ${escapeSlackMrkdwn(diagnosis.proposedFix.slice(0, 500))}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Source:* ${formatSourceRef(sourceRef)}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `No code fix required. Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: No fix needed — ${errorMessage.slice(0, 100)}`,
    blocks,
    'no-fix-needed message'
  );
}

/**
 * Post a Slack notification when the agent had low confidence and could not
 * proceed. The error likely needs a fix but human investigation is required.
 */
export async function postSreLowConfidenceMessage(
  trackingId: string,
  diagnosis: { rootCause: string; confidence: number },
  errorMessage: string,
  fingerprint: string,
  thresholds: { askThreshold: number },
  sourceRef: string,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'low-confidence message');
  if (!ws) return;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Low Confidence', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Confidence:* ${diagnosis.confidence}% (threshold: ${thresholds.askThreshold}%)`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Root Cause (unverified):* ${escapeSlackMrkdwn(diagnosis.rootCause.slice(0, 500))}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Source:* ${formatSourceRef(sourceRef)}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Human investigation recommended. Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: Low confidence — ${errorMessage.slice(0, 100)}`,
    blocks,
    'low-confidence message'
  );
}

/**
 * Post a Slack notification when the daily fix rate limit was reached.
 * The error may still need a fix - retry after the limit resets.
 */
export async function postSreRateLimitedMessage(
  trackingId: string,
  diagnosis: { rootCause: string; confidence: number },
  errorMessage: string,
  fingerprint: string,
  rateInfo: { fixesToday: number; maxFixesPerDay: number },
  sourceRef: string,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'rate-limited message');
  if (!ws) return;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Rate Limited', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Rate limit:* ${rateInfo.fixesToday}/${rateInfo.maxFixesPerDay} fixes dispatched today`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Root Cause:* ${escapeSlackMrkdwn(diagnosis.rootCause.slice(0, 500))}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Source:* ${formatSourceRef(sourceRef)}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Eligible for retry tomorrow. Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: Rate limited — ${errorMessage.slice(0, 100)}`,
    blocks,
    'rate-limited message'
  );
}

/**
 * Post a Slack notification when an analysis-phase failure occurs (circuit
 * breaker, GitHub unavailable, diagnosis null). Distinct from workflow failures
 * which happen post-dispatch.
 */
export async function postSreAnalysisFailureMessage(
  trackingId: string,
  fingerprint: string,
  errorMessage: string,
  failureReason: string,
  sourceRef: string,
  slackConfig: { workspaceId?: string; channelId?: string },
  phaseLabel = 'Analysis'
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'analysis-failure message');
  if (!ws) return;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `SRE Agent — ${phaseLabel} Failed`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reason:* ${escapeSlackMrkdwn(failureReason.slice(0, 500))}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Source:* ${formatSourceRef(sourceRef)}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${phaseLabel} phase failure — no fix was attempted. Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: ${phaseLabel.toLowerCase()} failed — ${failureReason.slice(0, 100)}`,
    blocks,
    'analysis-failure message'
  );
}

/**
 * Post a Slack notification when a fix PR is successfully created.
 */
export async function postSreFixSuccessMessage(
  trackingId: string,
  fingerprint: string,
  errorMessage: string,
  prNumber: number,
  prUrl: string,
  workflowRunUrl: string | undefined,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'fix-success message');
  if (!ws) return;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Fix PR Created', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*PR:* <${prUrl.replace(/[>|]/g, '')}|#${prNumber}>${workflowRunUrl ? `  *Workflow:* <${workflowRunUrl.replace(/[>|]/g, '')}|View Run>` : ''}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Draft PR ready for review. Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(ws.client, ws.channelId, `SRE Agent: Fix PR #${prNumber} created`, blocks, 'fix-success message');
}

/**
 * Post a Slack notification when the GitHub Actions workflow fails.
 */
export async function postSreFixFailureMessage(
  trackingId: string,
  fingerprint: string,
  errorMessage: string,
  failureReason: string,
  workflowRunUrl: string | undefined,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'fix-failure message');
  if (!ws) return;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Workflow Failed', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Failure:* ${escapeSlackMrkdwn(failureReason.slice(0, 500))}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: workflowRunUrl
          ? `*Workflow:* <${workflowRunUrl.replace(/[>|]/g, '')}|View Run>`
          : '*Workflow:* URL not available',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: Workflow failed — ${failureReason.slice(0, 100)}`,
    blocks,
    'fix-failure message'
  );
}

/**
 * Post a summary Slack notification when stale dispatches are timed out.
 */
export async function postSreTimeoutSummaryMessage(
  count: number,
  totalChecked: number,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'timeout-summary message');
  if (!ws) return;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Stale Dispatches Timed Out', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Timed out:* ${count} of ${totalChecked} checked`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Check SRE dashboard for details',
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: ${count} stale dispatches timed out`,
    blocks,
    'timeout-summary message'
  );
}

/**
 * Get allowed approver IDs from the SRE config (admin settings).
 * Resolves per-repo slack config using the tracking doc's repoSlug.
 * Returns empty array if not configured (anyone can approve).
 */
async function getAllowedApproverIds(trackingId?: string): Promise<string[]> {
  const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
  const sreConfig = SreAgentConfigSchema.parse(rawConfig ?? {});

  // Resolve per-repo slack config if we have a tracking doc with repoSlug
  let repoSlug = SRE_DEFAULT_REPO_SLUG;
  if (trackingId) {
    const tracking = await sreErrorTrackingRepository.findFullById(trackingId);
    if (tracking?.repoSlug) {
      repoSlug = tracking.repoSlug;
    }
  }
  const repoConfig = resolveFullConfig(sreConfig, repoSlug);
  if (!repoConfig) return [];

  const configApprovers = repoConfig.slack?.approverIds || '';
  if (configApprovers.trim()) {
    return configApprovers
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * Send an update to Slack via the response_url provided in the interactive payload.
 * This is the recommended pattern for updating messages after button clicks.
 */
async function sendSlackResponse(responseUrl: string, message: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      logger.error('[SRE-SLACK-APPROVAL] Failed to send response', { status: response.status });
    }
  } catch (error) {
    logger.error('[SRE-SLACK-APPROVAL] Error sending Slack response', { error });
  }
}

/**
 * Process the approval/rejection asynchronously and send results via response_url.
 * Runs fire-and-forget so the Slack interactive endpoint can respond within 3 seconds.
 */
async function processApprovalAsync(
  actionId: string,
  trackingId: string,
  user: { id: string; name?: string },
  responseUrl?: string
): Promise<void> {
  const respond = async (message: Record<string, unknown>) => {
    if (responseUrl) await sendSlackResponse(responseUrl, { replace_original: true, blocks: [], ...message });
  };

  try {
    if (actionId === 'sre_approve_fix') {
      // Load config and check rate limit
      const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
      const sreConfig = SreAgentConfigSchema.parse(rawConfig ?? {});

      // Atomic state transition: only proceed if still awaiting_approval.
      // Include dispatchedAt atomically to prevent gap if Lambda crashes between transition and updateStatus.
      const tracking = await sreErrorTrackingRepository.atomicTransition(trackingId, 'awaiting_approval', 'fixing', {
        dispatchedAt: new Date(),
      });
      if (!tracking) {
        await respond({ text: ':warning: This fix request has already been processed.' });
        return;
      }

      const repoSlug = tracking.repoSlug ?? SRE_DEFAULT_REPO_SLUG;
      const repoConfig = resolveFullConfig(sreConfig, repoSlug);

      if (!repoConfig) {
        await respond({ text: ':warning: Repo not configured in SRE config.' });
        return;
      }

      // Check per-repo rate limit
      const repoFixesToday = await sreErrorTrackingRepository.countFixesDispatchedToday(repoSlug);
      if (repoFixesToday >= repoConfig.maxFixesPerDay) {
        await sreErrorTrackingRepository.updateStatus(trackingId, 'rate_limited', {
          errorMessage: `Daily fix rate limit reached at time of approval (${repoFixesToday}/${repoConfig.maxFixesPerDay})`,
        });
        await respond({
          text: `:warning: Fix rate limit reached (repo: ${repoFixesToday}/${repoConfig.maxFixesPerDay} today). Request marked as rate_limited.`,
        });
        return;
      }

      if (!tracking.diagnosisResult) {
        await respond({ text: ':x: Error: No diagnosis found on tracking document.' });
        return;
      }

      const fixRequest: SreFixRequest = {
        trackingId: tracking.id,
        fingerprint: tracking.errorFingerprint,
        repoSlug,
        diagnosis: tracking.diagnosisResult,
        source: tracking.source as SreSourceType,
        issueNumber: tracking.githubIssueNumber,
      };

      await sendToQueue(getSourceQueueUrl('sreFixQueue'), fixRequest as unknown as Record<string, unknown>);

      logger.info('[SRE-SLACK-APPROVAL] Approved and dispatched', {
        trackingId,
        approvedBy: user.name || user.id,
      });

      await respond({ text: `:white_check_mark: Fix approved by <@${user.id}>. Dispatched to Surgeon.` });
    } else {
      // sre_reject_fix - atomic transition from awaiting_approval
      const tracking = await sreErrorTrackingRepository.atomicTransition(trackingId, 'awaiting_approval', 'wont_fix');
      if (!tracking) {
        await respond({ text: ':warning: This fix request has already been processed.' });
        return;
      }

      logger.info('[SRE-SLACK-APPROVAL] Rejected via Slack', {
        trackingId,
        rejectedBy: user.name || user.id,
      });

      await respond({ text: `:no_entry_sign: Fix rejected by <@${user.id}>. Marked as wont_fix.` });
    }
  } catch (error) {
    logger.error('[SRE-SLACK-APPROVAL] Error processing approval', { error, trackingId });
    await respond({ text: ':x: Error processing approval. Check logs.' });
  }
}

/**
 * Handle an SRE approval/rejection action from Slack interactive callback.
 * Called from the main /api/slack/interactive endpoint.
 *
 * Returns an immediate response (within Slack's 3-second deadline) and processes
 * the actual approval asynchronously via response_url.
 *
 * Authorization: checks approver against config approverIds.
 * Atomic: uses findOneAndUpdate to transition status, preventing double-approve.
 */
export async function handleSreApprovalAction(
  actionId: string,
  trackingId: string | undefined,
  user: { id: string; name?: string },
  responseUrl?: string
): Promise<{ response: Record<string, unknown>; deferred?: Promise<void> }> {
  if (!trackingId) {
    return { response: { text: 'Missing tracking ID.', response_type: 'ephemeral' } };
  }

  // Authorization check (fast - can run synchronously before the 3s deadline)
  const allowedApprovers = await getAllowedApproverIds(trackingId);
  if (allowedApprovers.length > 0 && !allowedApprovers.includes(user.id)) {
    logger.warn('[SRE-SLACK-APPROVAL] Unauthorized approval attempt', {
      userId: user.id,
      userName: user.name,
    });
    return {
      response: {
        response_type: 'ephemeral',
        text: ':no_entry: You are not authorized to approve SRE fixes.',
      },
    };
  }

  // Send immediate hourglass via response_url. Slack ignores the HTTP response
  // body for block_actions payloads - only response_url POSTs update the message.
  // Awaited so it completes before the Lambda handler returns.
  if (responseUrl) {
    await sendSlackResponse(responseUrl, {
      replace_original: true,
      blocks: [],
      text: ':hourglass: Processing approval...',
    });
  }

  // Return response + deferred work. Caller awaits deferred after res.json()
  // to prevent Lambda freeze from killing it mid-flight.
  const deferred = processApprovalAsync(actionId, trackingId, user, responseUrl).catch(err => {
    logger.error('[SRE-SLACK-APPROVAL] Async processing failed', { error: err, trackingId });
    if (responseUrl) {
      sendSlackResponse(responseUrl, {
        replace_original: true,
        blocks: [],
        text: ':x: Error processing approval. Check logs.',
      });
    }
  });

  return { response: {}, deferred };
}

/**
 * Post a Slack notification that a revision is in progress for an SRE fix PR.
 */
export async function postSreRevisionStartedMessage(
  trackingId: string,
  fingerprint: string,
  prUrl: string,
  revisionCount: number,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'revision-started message');
  if (!ws) return;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Revision In Progress', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `A reviewer requested changes on an SRE fix PR. The Diagnostician is revising the fix.\n*Revision:* #${revisionCount}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\`\n*PR:* <${prUrl.replace(/[>|]/g, '')}|View PR>`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: Revision #${revisionCount} in progress`,
    blocks,
    'revision-started message'
  );
}

/**
 * Post a Slack notification when a CI check fails and the SRE agent is re-analyzing.
 */
export async function postSreCiRetryMessage(
  trackingId: string,
  fingerprint: string,
  ciRetryCount: number,
  failureReason: string,
  workflowRunUrl: string,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'ci-retry message');
  if (!ws) return;

  const runUrlText = workflowRunUrl ? `\n*Run:* <${workflowRunUrl.replace(/[>|]/g, '')}|View Run>` : '';
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — CI Check Failed, Re-analyzing', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `A CI check failed on the generated fix. The Diagnostician is re-analyzing with the failure context.\n*Retry:* #${ciRetryCount}\n*Failure:* ${escapeSlackMrkdwn(failureReason.slice(0, 200))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\`${runUrlText}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Tracking: \`${trackingId}\`` }],
    },
  ];

  await postBlocks(ws.client, ws.channelId, `SRE Agent: CI retry #${ciRetryCount}`, blocks, 'ci-retry message');
}

/**
 * Post a Slack escalation notification when max revisions are reached.
 * A human needs to take over the fix.
 */
export async function postSreRevisionEscalationMessage(
  trackingId: string,
  fingerprint: string,
  prUrl: string,
  revisionCount: number,
  reviewerFeedback: string,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'revision-escalation message');
  if (!ws) return;

  const truncatedFeedback = reviewerFeedback.length > 500 ? reviewerFeedback.slice(0, 500) + '...' : reviewerFeedback;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Human Intervention Needed', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `The SRE Agent has reached the maximum number of revision attempts (${revisionCount}). A human needs to complete this fix.\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\`\n*PR:* <${prUrl.replace(/[>|]/g, '')}|View PR>`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Latest Reviewer Feedback:*\n${escapeSlackMrkdwn(truncatedFeedback)}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tracking: \`${trackingId}\``,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: Max revisions reached — human intervention needed`,
    blocks,
    'revision-escalation message'
  );
}

/**
 * Post a Slack notification when the recurrence guard fires - a fingerprint has
 * re-appeared after one or more prior autofixes were merged, meaning the
 * workaround(s) were ineffective. Escalates to humans for root-cause work.
 */
export async function postSreRecurrenceDetectedMessage(
  trackingId: string,
  fingerprint: string,
  priorFixPrNumbers: number[],
  repoSlug: string,
  rootCauseTrackingIssue: number | undefined,
  rootCause: string,
  sourceRef: string,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'recurrence-detected message');
  if (!ws) return;

  const priorPrLinks = priorFixPrNumbers.map(n => `<https://github.com/${repoSlug}/pull/${n}|#${n}>`).join(', ');
  const rootCauseLine = rootCauseTrackingIssue
    ? `*Root-Cause Issue:* <https://github.com/${repoSlug}/issues/${rootCauseTrackingIssue}|#${rootCauseTrackingIssue}>`
    : '*Root-Cause Issue:* _none linked_ — operator should create one and PATCH the pattern entry to record it';
  const truncatedRootCause = rootCause.length > 300 ? rootCause.slice(0, 300) + '…' : rootCause;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Workaround Ineffective', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `This fingerprint has recurred after ${priorFixPrNumbers.length} prior autofix PR(s) were merged. The automated workaround is not resolving the underlying issue — escalating for root-cause investigation.\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\`\n*Repo:* \`${repoSlug}\`\n*Prior Fix PRs:* ${priorPrLinks}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: rootCauseLine },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Latest Diagnosis:*\n${escapeSlackMrkdwn(truncatedRootCause)}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Source:* ${formatSourceRef(sourceRef)}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tracking: \`${trackingId}\` — to override (e.g., if the prior fix is genuinely unrelated), use the admin Retry button or PATCH \`/api/sre/patterns/[id]\` to clear \`workaroundIneffective\`.`,
        },
      ],
    },
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    'SRE Agent: Workaround ineffective — escalating',
    blocks,
    'recurrence-detected message'
  );
}

/**
 * Post a Slack notification when a fix was already applied by a prior SRE run
 * (idempotent patches detected no changes). Prompts the human to verify and close
 * the original GitHub issue if the prior fix resolved it.
 */
export async function postSreAlreadyFixedMessage(
  trackingId: string,
  errorMessage: string,
  fingerprint: string,
  githubIssueNumber: number | undefined,
  repoSlug: string,
  workflowRunUrl: string | undefined,
  slackConfig: { workspaceId?: string; channelId?: string }
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'already-fixed message');
  if (!ws) return;

  const issueUrl = githubIssueNumber
    ? `https://github.com/${repoSlug}/issues/${githubIssueNumber}`.replace(/[>|]/g, '')
    : undefined;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'SRE Agent — Already Fixed', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `A prior SRE run already applied this fix. Please verify the original issue is resolved and close the GitHub issue if so.${issueUrl ? `\n*GitHub Issue:* <${issueUrl}|#${githubIssueNumber}>` : ''}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: workflowRunUrl
            ? `Workflow run: <${workflowRunUrl.replace(/[>|]/g, '')}|view run> — Tracking: \`${trackingId}\``
            : `Tracking: \`${trackingId}\``,
        },
      ],
    },
    ...(issueUrl
      ? ([
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'View GitHub Issue', emoji: true },
                url: issueUrl,
                action_id: 'sre_view_github_issue',
              },
            ],
          },
        ] as KnownBlock[])
      : []),
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: Already fixed — ${errorMessage.slice(0, 100)}`,
    blocks,
    'already-fixed message'
  );
}

/**
 * Post a Slack notification when a fix loop is detected - a recent fix exists but
 * the error has recurred, indicating the prior fix did not address the root cause.
 * More alarming than "no fix needed" - distinct messaging to prompt investigation.
 *
 * When `triggerAction === 'reopened'` the header and body are reworded to make it
 * clear the signal came from a user actively reopening the closed issue
 * rather than a natural re-occurrence of the same error fingerprint.
 */
export async function postSreFixLoopMessage(
  trackingId: string,
  errorMessage: string,
  fingerprint: string,
  githubIssueNumber: number | undefined,
  repoSlug: string,
  slackConfig: { workspaceId?: string; channelId?: string },
  triggerAction?: 'opened' | 'labeled' | 'reopened'
): Promise<void> {
  const ws = await resolveWorkspace(slackConfig, 'fix-loop message');
  if (!ws) return;

  const issueUrl = githubIssueNumber
    ? `https://github.com/${repoSlug}/issues/${githubIssueNumber}`.replace(/[>|]/g, '')
    : undefined;

  const isReopen = triggerAction === 'reopened';
  const headerText = isReopen ? 'SRE Agent — Fix Loop Detected (Reopened)' : 'SRE Agent — Fix Loop Detected';
  const bodyText = isReopen
    ? `The original reporter reopened this issue after the SRE fix merged — strong signal that the prior fix did not address the root cause. Human investigation required.`
    : `A recent fix exists for this fingerprint but the error recurred. Human investigation required — the prior fix may not have addressed the root cause.`;

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:* ${escapeSlackMrkdwn(errorMessage.slice(0, 300))}\n*Fingerprint:* \`${fingerprint.slice(0, 12)}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${bodyText}${issueUrl ? `\n*GitHub Issue:* <${issueUrl}|#${githubIssueNumber}>` : ''}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tracking: \`${trackingId}\``,
        },
      ],
    },
    ...(issueUrl
      ? ([
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Review GitHub Issue', emoji: true },
                url: issueUrl,
                action_id: 'sre_review_github_issue_fix_loop',
                style: 'danger',
              },
            ],
          },
        ] as KnownBlock[])
      : []),
  ];

  await postBlocks(
    ws.client,
    ws.channelId,
    `SRE Agent: Fix loop detected — ${errorMessage.slice(0, 100)}`,
    blocks,
    'fix-loop message'
  );
}
