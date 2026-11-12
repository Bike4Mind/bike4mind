/**
 * Posting to an org's opted-in Slack channel as the Bike4Mind bot, shared by POST /api/v1/slack/messages
 * (apps/client/pages/api/v1/slack/messages.ts) and the loop run's `loop_slack_post` tool
 * (apps/workers/src/queueHandlers/agentExecutor.loopSlackTools.ts). The org owner opts a channel in through
 * pages/api/organizations/[id]/integrations/slack/channels.ts.
 */
import {
  BadGatewayError,
  ConflictError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
} from '@bike4mind/common';
import { cacheRepository } from '@bike4mind/database';
import {
  organizationRepository,
  orgSlackWorkspaceRepository,
  slackChannelConfigRepository,
} from '@bike4mind/database/infra';
import { ErrorCode, WebClient, type ChatPostMessageArguments } from '@slack/web-api';

export type OrgChannelPostDenial =
  | 'channel_not_enabled'
  | 'key_not_allowlisted'
  | 'workspace_not_connected'
  | 'opt_in_from_other_org'
  | 'key_bills_other_org'
  | 'not_org_member';

export type OrgChannelPostAuthorization =
  | { ok: true; organizationId: string; encryptedBotToken?: string | null }
  | { ok: false; reason: OrgChannelPostDenial; organizationId?: string };

/**
 * Whether `userId` may post to `channelId`, in the route's order of checks: the channel is opted in (and, when it
 * lists allowed keys, for `keyId`; a caller with no key, like a loop, is then refused), its workspace is connected
 * to the org that granted the opt-in, a key billing an org bills that org, and the user is a member of it (no admin
 * bypass). The bot token is returned still encrypted, so a caller spends its budget before decrypting.
 */
export async function authorizeOrgChannelPost({
  channelId,
  userId,
  keyId,
  keyOrgId,
}: {
  channelId: string;
  userId: string;
  keyId?: string;
  keyOrgId?: string;
}): Promise<OrgChannelPostAuthorization> {
  const config = await slackChannelConfigRepository.findByChannelId(channelId);
  if (!config?.apiPostEnabled) return { ok: false, reason: 'channel_not_enabled' };
  const allowedKeyIds = config.apiPostAllowedKeyIds ?? [];
  if (allowedKeyIds.length > 0 && !(keyId && allowedKeyIds.includes(keyId))) {
    return { ok: false, reason: 'key_not_allowlisted' };
  }

  const workspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(config.slackTeamId);
  if (!workspace) return { ok: false, reason: 'workspace_not_connected' };
  const { organizationId } = workspace;
  if (config.apiPostOrganizationId !== organizationId) {
    return { ok: false, reason: 'opt_in_from_other_org', organizationId };
  }
  if (keyOrgId && keyOrgId !== organizationId) return { ok: false, reason: 'key_bills_other_org', organizationId };
  const memberOrgIds = await organizationRepository.findMembershipOrgIds(userId);
  if (!memberOrgIds.includes(organizationId)) return { ok: false, reason: 'not_org_member', organizationId };
  return { ok: true, organizationId, encryptedBotToken: workspace.slackBotToken };
}

export const SLACK_POSTS_PER_CHANNEL_PER_MINUTE = 60;
/** The v1 messages route's rate-limit bucket prefix; the channel budget below shares its `channel-minute` bucket. */
export const SLACK_MESSAGES_POST_BUCKET = 'POST /api/v1/slack/messages';
/** Must match the route's `channelRateLimit` key (`rate-limit:<subject>:<bucket>`), so every poster shares it. */
const CHANNEL_BUDGET_KEY = (channelId: string) =>
  `rate-limit:channel:${channelId}:${SLACK_MESSAGES_POST_BUCKET}:channel-minute`;

/** Spends one post of the channel's per-minute budget; false when it is used up. */
export async function spendSlackChannelBudget(channelId: string): Promise<boolean> {
  const { success } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
    CHANNEL_BUDGET_KEY(channelId),
    SLACK_POSTS_PER_CHANNEL_PER_MINUTE,
    60 * 1000
  );
  return success;
}

/** chat.postMessage with no SDK retries: a Lambda must not sit out Slack's back-off, and the caller can retry. */
export function postOrgSlackMessage(botToken: string, message: ChatPostMessageArguments) {
  const client = new WebClient(botToken, {
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: 10_000,
  });
  return client.chat.postMessage(message);
}

const BOT_NOT_IN_CHANNEL_MESSAGE =
  'The Bike4Mind bot is not a member of this channel. Invite it with /invite @<bot name>, then retry.';

/** Slack errors that mean the bot cannot see the channel; a private channel answers channel_not_found. */
const NOT_IN_CHANNEL_ERRORS = new Set(['not_in_channel', 'channel_not_found']);
/** Slack's refusals of the message itself, which the caller can fix. */
const INVALID_MESSAGE_ERRORS = new Set([
  'invalid_blocks',
  'invalid_blocks_format',
  'msg_too_long',
  'no_text',
  'thread_not_found',
  'invalid_thread_ts',
]);
/** The channel's posting restrictions (announcement-only, thread-only) refused the bot. */
const RESTRICTED_CHANNEL_ERRORS = new Set([
  'restricted_action',
  'restricted_action_read_only_channel',
  'restricted_action_thread_only_channel',
  'restricted_action_non_threadable_channel',
]);
/** Slack refused the workspace's bot credentials. */
const REJECTED_CREDENTIAL_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
]);

type SlackCallError = { code?: string; data?: { error?: string }; retryAfter?: number };

/** Maps a failed chat.postMessage to the error the caller sees, plus the outcome label we log. */
export function toCallerError(error: unknown): { outcome: string; error: Error; retryAfter?: number } {
  const { code, data, retryAfter } = (error ?? {}) as SlackCallError;
  if (code === ErrorCode.RateLimitedError) {
    return {
      outcome: 'slack_rate_limited',
      error: new TooManyRequestsError('Slack is rate limiting the bot. Retry after the Retry-After interval.'),
      retryAfter,
    };
  }
  const slackError = code === ErrorCode.PlatformError ? data?.error : undefined;
  if (!slackError)
    return { outcome: 'slack_unreachable', error: new BadGatewayError('Slack did not accept the message.') };
  if (NOT_IN_CHANNEL_ERRORS.has(slackError)) {
    return {
      outcome: slackError,
      error: new ConflictError(BOT_NOT_IN_CHANNEL_MESSAGE, { errorCode: 'slack_bot_not_in_channel' }),
    };
  }
  if (slackError === 'is_archived') {
    return {
      outcome: slackError,
      error: new ConflictError('This channel is archived.', { errorCode: 'slack_channel_archived' }),
    };
  }
  if (RESTRICTED_CHANNEL_ERRORS.has(slackError)) {
    return {
      outcome: slackError,
      error: new ConflictError(
        'This channel restricts posting (for example announcement-only or thread-only) and refused the message.',
        { errorCode: 'slack_channel_restricted' }
      ),
    };
  }
  if (INVALID_MESSAGE_ERRORS.has(slackError)) {
    return { outcome: slackError, error: new UnprocessableEntityError(`Slack rejected the message: ${slackError}.`) };
  }
  if (REJECTED_CREDENTIAL_ERRORS.has(slackError)) {
    return {
      outcome: slackError,
      error: new UnauthorizedError(
        "Slack refused this organization's workspace connection. An organization owner must reconnect Slack.",
        { errorCode: 'provider_rejected' }
      ),
    };
  }
  return { outcome: slackError, error: new BadGatewayError(`Slack did not accept the message: ${slackError}.`) };
}
