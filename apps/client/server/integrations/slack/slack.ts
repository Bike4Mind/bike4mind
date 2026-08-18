import axios from 'axios';
import { Config } from '@server/utils/config';
import { Logger } from '@bike4mind/observability';
import { isPlaceholderValue } from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { buildEmailMirrorMessage, type EmailMirrorPayload } from './emailMirror';

/** Channel-specific Slack incoming-webhook settings (each maps to a dedicated Slack channel). */
type SlackChannelSettingKey =
  | 'SlackGeneralWebhookUrl'
  | 'SlackLiveopsWebhookUrl'
  | 'SlackUserActivityWebhookUrl'
  | 'SlackFeedbackWebhookUrl'
  | 'SlackEmailAuditWebhookUrl';

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
  // SST secrets fall back to a placeholder (e.g. 'not-configured') when unset, which is truthy.
  // Normalize placeholders to '' so callers' `if (!slackWebhookUrl)` guards detect the unconfigured state.
  return isPlaceholderValue(resolved) ? '' : resolved;
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

/**
 * Outcome of one delivery attempt. Returned rather than swallowed because the feedback record is
 * already saved by the time this runs - the submitter is correctly told it succeeded, and the only
 * thing that can go wrong from here is that nobody on our side ever hears about it.
 */
export type FeedbackDeliveryOutcome =
  | { status: 'delivered' }
  | { status: 'skipped'; reason: 'disabled' | 'no_webhook_configured' | 'no_recipients' }
  | { status: 'failed'; reason: string };

export async function postFeedbackToSlack(
  type: string,
  organization: string,
  username: string,
  userEmail: string,
  userId: string,
  content: string,
  promptMeta: string
): Promise<FeedbackDeliveryOutcome> {
  try {
    // No NODE_ENV gate. Admin settings are per-stage (each stage has its own database, see the
    // %STAGE% placeholder in the MONGODB_URI template), so SlackFeedbackWebhookUrl already routes
    // each stage to its own channel. Gating on NODE_ENV instead made non-production stages
    // unverifiable while doing nothing to separate them, since deployed stages run a production
    // build regardless.
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const slackWebhookUrl = resolveSlackWebhookUrl('SlackFeedbackWebhookUrl', settings);

    if (!slackWebhookUrl) {
      Logger.error(
        'Error posting feedback to Slack: no SlackFeedbackWebhookUrl / SlackDefaultWebhookUrl set in admin settings or config'
      );
      return { status: 'skipped', reason: 'no_webhook_configured' };
    }

    const message = `*Type:* ${type}\n*User Details:* ${organization} - ${username} (ID: ${userId})\n*User Email:* ${userEmail}\n*Feedback:* ${content}
    \n*Prompt Meta:* ${promptMeta}`;

    await axios.post(
      slackWebhookUrl,
      { text: message },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    return { status: 'delivered' };
  } catch (error) {
    Logger.error('Error posting feedback to Slack:', error);
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
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
