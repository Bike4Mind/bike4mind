import axios from 'axios';
import { Config } from '@server/utils/config';
import { Logger } from '@bike4mind/observability';
import { classifyStage, isPlaceholderValue } from '@bike4mind/common';
import type {
  FeedbackDeliveryStageClass,
  FeedbackDeliverySkipReason,
  FeedbackChannelDelivery,
} from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { buildEmailMirrorMessage, type EmailMirrorPayload } from './emailMirror';
import {
  recordFeedbackDeliverySuccess,
  recordFeedbackDeliveryFailure,
  recordFeedbackDeliverySkipped,
} from '@server/utils/cloudwatch';

/** Channel-specific Slack incoming-webhook settings (each maps to a dedicated Slack channel). */
type SlackChannelSettingKey =
  | 'SlackGeneralWebhookUrl'
  | 'SlackLiveopsWebhookUrl'
  | 'SlackUserActivityWebhookUrl'
  | 'SlackFeedbackWebhookUrl'
  | 'SlackEmailAuditWebhookUrl';

// Trim a raw setting value and normalize an SST placeholder (e.g. 'not-configured', which is
// truthy) to '' so callers' `if (!url)` guards detect the unconfigured state.
function normalizeWebhookUrl(raw: string | undefined): string {
  const trimmed = raw?.trim() || '';
  return isPlaceholderValue(trimmed) ? '' : trimmed;
}

/**
 * Resolves the Slack incoming-webhook URL for a channel, falling back to the
 * admin-configurable default (`SlackDefaultWebhookUrl`) and finally the
 * `SLACK_WEBHOOK_URL` secret. Returns an empty string when none are configured.
 */
export function resolveSlackWebhookUrl(channel: SlackChannelSettingKey, settings: Record<string, string>): string {
  // Trim each source before the `||` so a padded URL is usable and a whitespace-only value is treated
  // as empty, letting the fallback chain (channel -> SlackDefaultWebhookUrl -> SLACK_WEBHOOK_URL) continue.
  const resolved =
    getSettingsValue(channel, settings)?.trim() ||
    getSettingsValue('SlackDefaultWebhookUrl', settings)?.trim() ||
    Config.SLACK_WEBHOOK_URL?.trim() ||
    '';
  return normalizeWebhookUrl(resolved);
}

type FeedbackSlackRoute =
  | { kind: 'post'; webhookUrl: string; stageClass: FeedbackDeliveryStageClass }
  | { kind: 'skip'; stageClass: FeedbackDeliveryStageClass; reason: FeedbackDeliverySkipReason };

/**
 * Decides where feedback-to-Slack posts go for a given deploy stage, via the shared
 * classifyStage() (@bike4mind/common) - the single source of truth for the
 * production/non-production split, so a future stage rename touches one file.
 *
 * Non-production stages deliberately do NOT fall through resolveSlackWebhookUrl's chain: doing so
 * would leak into SlackDefaultWebhookUrl / the production feedback channel, which is exactly the
 * stage-leak bug this resolver exists to close (a deployed Lambda's NODE_ENV commonly reads
 * 'production' independent of the actual deploy stage, since nothing in infra/ sets it per stage,
 * so the old check could not reliably separate stages).
 *
 * `singleEnvironmentInstall` (a self-host deploy) routes like production - one environment, its
 * own settings store, no shared production channel to leak into - without relabeling `stageClass`
 * itself, so metrics/logs still report the install's real (non-production) stage classification.
 */
export function resolveFeedbackSlackRoute(
  stage: string | undefined,
  settings: Record<string, string>,
  singleEnvironmentInstall = false
): FeedbackSlackRoute {
  const stageClass: FeedbackDeliveryStageClass = classifyStage(stage);

  if (stageClass === 'production' || singleEnvironmentInstall) {
    const webhookUrl = resolveSlackWebhookUrl('SlackFeedbackWebhookUrl', settings);
    return webhookUrl
      ? { kind: 'post', webhookUrl, stageClass }
      : { kind: 'skip', stageClass, reason: 'unconfigured_webhook' };
  }

  const webhookUrl = normalizeWebhookUrl(getSettingsValue('SlackNonProdFeedbackWebhookUrl', settings));
  return webhookUrl
    ? { kind: 'post', webhookUrl, stageClass }
    : { kind: 'skip', stageClass, reason: 'nonprod_unconfigured' };
}

export async function postMessageToSlack(message: string): Promise<void> {
  try {
    // Generic / operational notifications route to the LiveOps channel.
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const slackWebhookUrl = resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', settings);

    if (!slackWebhookUrl) {
      Logger.error(
        'Error posting message to Slack: no SlackLiveopsWebhookUrl / SlackDefaultWebhookUrl set in admin settings or config'
      );
      return;
    }

    await axios.post(
      slackWebhookUrl,
      { text: message },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    Logger.error('Error posting message to Slack:', error);
  }
}

export async function postFeedbackToSlack(
  type: string,
  organization: string,
  username: string,
  userEmail: string,
  userId: string,
  content: string,
  promptMeta: string
): Promise<FeedbackChannelDelivery> {
  try {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const route = resolveFeedbackSlackRoute(Config.STAGE, settings, process.env.B4M_SELF_HOST === 'true');

    if (route.kind === 'skip') {
      // 'nonprod_unconfigured' is the expected default until an operator opts a stage in - warn,
      // not error. 'unconfigured_webhook' means the production feedback channel itself is
      // unconfigured, which is a real operational gap.
      const log = route.reason === 'unconfigured_webhook' ? Logger.error : Logger.warn;
      log(
        `Skipping feedback-to-Slack post (stage=${route.stageClass}, reason=${route.reason}): ` +
          (route.reason === 'unconfigured_webhook'
            ? 'no SlackFeedbackWebhookUrl / SlackDefaultWebhookUrl set in admin settings or config'
            : 'no SlackNonProdFeedbackWebhookUrl configured for this non-production stage')
      );
      await recordFeedbackDeliverySkipped('slack', route.stageClass, route.reason, Config.STAGE);
      return { outcome: 'skipped', reason: route.reason };
    }

    // Prefix non-prod posts with the stage name so a mis-pointed non-prod webhook is self-evident
    // in the receiving channel.
    const stagePrefix = route.stageClass === 'nonprod' ? `*[${Config.STAGE}]*\n` : '';
    const message = `${stagePrefix}*Type:* ${type}\n*User Details:* ${organization} - ${username} (ID: ${userId})\n*User Email:* ${userEmail}\n*Feedback:* ${content}
    \n*Prompt Meta:* ${promptMeta}`;

    try {
      await axios.post(
        route.webhookUrl,
        { text: message },
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (postError) {
      const errorType = axios.isAxiosError(postError) ? String(postError.response?.status ?? 'network') : 'unknown';
      await recordFeedbackDeliveryFailure('slack', route.stageClass, errorType, Config.STAGE);
      Logger.error('Error posting feedback to Slack:', postError);
      return { outcome: 'failed', reason: 'error' };
    }
    await recordFeedbackDeliverySuccess('slack', route.stageClass);
    return { outcome: 'delivered' };
  } catch (error) {
    // Reached before `route` exists (e.g. getSettingsMap rejects on a Mongo timeout), so classify
    // from Config.STAGE directly rather than route.stageClass. Without this, a settings-store
    // outage is invisible to feedbackDeliveryFailures - the submitter gets the warning toast, but
    // the alarm never sees it.
    await recordFeedbackDeliveryFailure('slack', classifyStage(Config.STAGE), 'unhandled', Config.STAGE);
    Logger.error('Error posting feedback to Slack:', error);
    return { outcome: 'failed', reason: 'error' };
  }
}

/**
 * Mirror a copy of an outbound email to the email-audit Slack channel for
 * real-time visibility into what the platform is sending - broken links, wrong
 * content, or abuse coming through the contact form show up instantly. Routes
 * to the dedicated `SlackEmailAuditWebhookUrl` channel (should be PRIVATE,
 * need-to-know - the payload contains recipient PII). `payload.bodyPreview`
 * MUST already be redacted (see `emailMirror.ts`); this poster never touches
 * raw email content. Best-effort: a Slack failure is logged and swallowed so
 * it can never break email delivery.
 */
export async function postEmailMirrorToSlack(payload: EmailMirrorPayload): Promise<void> {
  try {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const slackWebhookUrl = resolveSlackWebhookUrl('SlackEmailAuditWebhookUrl', settings);

    // Unconfigured is the expected default - stay silent (debug only) so we don't
    // spam error logs on every email when the mirror channel isn't set up yet.
    if (!slackWebhookUrl) {
      Logger.debug('[email-mirror] SlackEmailAuditWebhookUrl not configured — skipping mirror');
      return;
    }

    await axios.post(
      slackWebhookUrl,
      { text: buildEmailMirrorMessage(payload) },
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    Logger.error('Error mirroring outbound email to Slack:', error);
  }
}

export async function postLowCreditsNotificationToSlack(
  userId: string,
  username: string,
  email: string,
  currentCredits: number,
  organization?: { id: string; name: string } | null
): Promise<void> {
  try {
    // Low-credit alerts are operational notifications -> LiveOps channel.
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const slackWebhookUrl = resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', settings);
    if (!slackWebhookUrl) {
      Logger.error(
        'Error posting low credits notification to Slack: no SlackLiveopsWebhookUrl / SlackDefaultWebhookUrl set in admin settings or config'
      );
      return;
    }

    const message = `⚠️ *Low Credits Alert*\n*User:* ${username} (${email})\n*User ID:* ${userId}\n*Current Credits:* ${currentCredits}\n${organization ? `*Organization:* ${organization.name} (${organization.id})` : ''}`;

    await axios.post(
      slackWebhookUrl,
      { text: message },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    Logger.error('Error posting low credits notification to Slack:', error);
  }
}
