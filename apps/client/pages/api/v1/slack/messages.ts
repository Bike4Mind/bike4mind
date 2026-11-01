/**
 * POST /api/v1/slack/messages - post to a Slack channel, or reply in a thread, as the Bike4Mind bot.
 *
 * Authorization, all of which must hold (each refusal is a 403 with one message, so the route never
 * says whether a channel id is configured somewhere the caller cannot see):
 *  1. an API key carrying `slack:post` (the contract's scope gate; a session JWT is refused here);
 *  2. the channel's SlackChannelConfig has `apiPostEnabled`, and its `apiPostAllowedKeyIds`, when
 *     non-empty, lists this key;
 *  3. the config's workspace is an enabled OrgSlackWorkspace of an org the key's owner is a member
 *     of, and an org-billed key bills that same org.
 * The org owner turns the opt-in on through
 * pages/api/organizations/[id]/integrations/slack/channels.ts.
 *
 * Logs carry the key id, org, channel, ts and outcome only: never the message body or a token.
 */

import {
  BadGatewayError,
  ConflictError,
  ForbiddenError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  escapeSlackLine,
  postSlackMessageContract,
  SLACK_API_POST_EVENT_TYPE,
  neutralizeSlackBroadcastMentions,
  neutralizeSlackBroadcastMentionsDeep,
} from '@bike4mind/common';
import {
  organizationRepository,
  orgSlackWorkspaceRepository,
  slackChannelConfigRepository,
} from '@bike4mind/database/infra';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { ErrorCode, WebClient, type KnownBlock } from '@slack/web-api';
import type { RequestHandler } from 'express';

const SLACK_POSTS_PER_MINUTE = 30;
const SLACK_POSTS_PER_DAY = 1000;

const NOT_ENABLED_MESSAGE =
  'This channel is not enabled for API posting by an organization you belong to, or not for this API key. ' +
  'An organization owner can enable it under the organization Slack integration.';

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
/** Slack refused the workspace's bot credentials. */
const REJECTED_CREDENTIAL_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
]);

const perKey = (req: Parameters<RequestHandler>[0]) => (req.apiKeyInfo ? `api-key:${req.apiKeyInfo.keyId}` : undefined);

const perMinuteLimit = rateLimit({
  limit: SLACK_POSTS_PER_MINUTE,
  windowMs: 60 * 1000,
  bucket: 'POST /api/v1/slack/messages:minute',
  subject: perKey,
});
const perDayLimit = rateLimit({
  limit: SLACK_POSTS_PER_DAY,
  windowMs: 24 * 60 * 60 * 1000,
  bucket: 'POST /api/v1/slack/messages:day',
  subject: perKey,
});

/** Both windows, minute first; counted per key on top of the key's own request limits. */
const slackPostRateLimit: RequestHandler = (req, res, next) =>
  perMinuteLimit(req, res, error => (error ? next(error) : perDayLimit(req, res, next)));

const ATTRIBUTION_NAME_MAX = 80;

/**
 * The context block appended to every API post, after the caller's blocks, naming who posted it and
 * with which key, so a message cannot pass itself off as the bot's own. Names are escaped, so neither
 * can carry a mention or link.
 */
function attributionBlock(userName: string, keyName: string): KnownBlock {
  const clip = (value: string) => escapeSlackLine(value.slice(0, ATTRIBUTION_NAME_MAX));
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Posted via API by ${clip(userName)} \u00B7 key ${clip(keyName)}` }],
  };
}

type SlackCallError = { code?: string; data?: { error?: string }; retryAfter?: number };

/** Maps a failed chat.postMessage to the error the caller sees, plus the outcome label we log. */
function toCallerError(error: unknown): { outcome: string; error: Error; retryAfter?: number } {
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

const handler = nextRouteForContract(postSlackMessageContract, {
  // 3,000 characters of text plus 40,000 of blocks, with room for JSON escaping.
  maxBodySize: 128 * 1024,
  rateLimit: slackPostRateLimit,
}).post(async (req, res) => {
  const { channel_id: channelId, text, blocks, thread_ts: threadTs } = req.validated;
  const keyId = req.apiKeyInfo?.keyId;
  const logContext = { keyId, userId: req.user.id, channelId };

  if (!req.apiKeyInfo || !keyId) {
    throw new ForbiddenError('This endpoint requires an API key carrying the slack:post scope.');
  }

  const deny = (reason: string, organizationId?: string): never => {
    req.logger.info('[slack-post] refused', { ...logContext, organizationId, outcome: reason });
    throw new ForbiddenError(NOT_ENABLED_MESSAGE);
  };

  const config = await slackChannelConfigRepository.findByChannelId(channelId);
  if (!config?.apiPostEnabled) return deny('channel_not_enabled');
  const allowedKeyIds = config.apiPostAllowedKeyIds ?? [];
  if (allowedKeyIds.length > 0 && !allowedKeyIds.includes(keyId)) return deny('key_not_allowlisted');

  const workspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(config.slackTeamId);
  if (!workspace) return deny('workspace_not_connected');
  const { organizationId } = workspace;

  const keyOrgId = req.apiKeyInfo.organizationId;
  if (keyOrgId && keyOrgId !== organizationId) return deny('key_bills_other_org', organizationId);
  // Membership, not platform-admin reach: no admin bypass, so a key only ever posts as its owner's own org.
  const memberOrgIds = await organizationRepository.findMembershipOrgIds(req.user.id);
  if (!memberOrgIds.includes(organizationId)) return deny('not_org_member', organizationId);

  const botToken = decryptToken(workspace.slackBotToken);
  if (!botToken) {
    req.logger.error('[slack-post] workspace has no bot token', { ...logContext, organizationId });
    throw new BadGatewayError(
      'This organization has no working Slack connection. An organization owner must reconnect Slack.'
    );
  }

  const keyName = (await userApiKeyRepository.findById(keyId))?.name ?? keyId;
  const postedText = neutralizeSlackBroadcastMentions(text);
  // Without caller blocks the text becomes a section, so the attribution block has something to follow.
  const callerBlocks: KnownBlock[] = blocks
    ? (neutralizeSlackBroadcastMentionsDeep(blocks) as KnownBlock[])
    : [{ type: 'section', text: { type: 'mrkdwn', text: postedText } }];

  // No SDK retries: a Lambda request must not sit out Slack's back-off, and the caller can retry.
  const client = new WebClient(botToken, {
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: 10_000,
  });
  try {
    const result = await client.chat.postMessage({
      channel: channelId,
      text: postedText,
      blocks: [...callerBlocks, attributionBlock(req.user.name || 'unknown user', keyName)],
      ...(threadTs && { thread_ts: threadTs }),
      // Server-set (the request schema is strict, so a caller cannot supply metadata): it marks the
      // message as API-posted, which makes the interactivity handler refuse any action on it.
      metadata: { event_type: SLACK_API_POST_EVENT_TYPE, event_payload: { key_id: keyId, user_id: req.user.id } },
    });
    if (!result.ts) throw new BadGatewayError('Slack accepted the message but returned no timestamp.');

    req.logger.info('[slack-post] posted', {
      ...logContext,
      organizationId,
      ts: result.ts,
      threaded: Boolean(threadTs),
      outcome: 'posted',
    });
    return res.json({ ok: true, channel_id: channelId, ts: result.ts });
  } catch (error) {
    if (error instanceof BadGatewayError) throw error;
    const mapped = toCallerError(error);
    req.logger.warn('[slack-post] failed', { ...logContext, organizationId, outcome: mapped.outcome });
    if (typeof mapped.retryAfter === 'number') res.setHeader('Retry-After', mapped.retryAfter);
    throw mapped.error;
  }
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
