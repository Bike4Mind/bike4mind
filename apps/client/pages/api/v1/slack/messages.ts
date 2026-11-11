/**
 * POST /api/v1/slack/messages - post to a Slack channel, or reply in a thread, as the Bike4Mind bot.
 *
 * Authorization, all of which must hold (each refusal is a 403 with one message, so the route never
 * says whether a channel id is configured somewhere the caller cannot see):
 *  1. an API key carrying `slack:post` (the contract's scope gate; a session JWT is refused here);
 *  2. the channel's SlackChannelConfig has `apiPostEnabled`, and its `apiPostAllowedKeyIds`, when
 *     non-empty, lists this key;
 *  3. the config's workspace is an enabled OrgSlackWorkspace of an org the key's owner is a member
 *     of, that same org granted the opt-in, and an org-billed key bills that same org.
 * The org owner turns the opt-in on through
 * pages/api/organizations/[id]/integrations/slack/channels.ts.
 *
 * Logs carry the key id, org, channel, ts and outcome only: never the message body or a token.
 */

import {
  BadGatewayError,
  ForbiddenError,
  escapeSlackLine,
  postSlackMessageContract,
  SLACK_CHANNEL_ID_PATTERN,
  SLACK_API_POST_EVENT_TYPE,
  neutralizeSlackBroadcastMentions,
  neutralizeSlackBroadcastMentionsDeep,
} from '@bike4mind/common';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  authorizeOrgChannelPost,
  postOrgSlackMessage,
  SLACK_MESSAGES_POST_BUCKET,
  SLACK_POSTS_PER_CHANNEL_PER_MINUTE,
  toCallerError,
} from '@bike4mind/server-utils/integrations/slack/orgChannelPost';
import type { KnownBlock } from '@slack/web-api';
import type { RequestHandler } from 'express';

const SLACK_POSTS_PER_MINUTE = 30;
const SLACK_POSTS_PER_DAY = 1000;

const NOT_ENABLED_MESSAGE =
  'This channel is not enabled for API posting by an organization you belong to, or not for this API key. ' +
  'An organization owner can enable it under the organization Slack integration.';

type LimitedRequest = Parameters<RequestHandler>[0];

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET = SLACK_MESSAGES_POST_BUCKET;

const perKey = (req: LimitedRequest) => (req.apiKeyInfo ? `api-key:${req.apiKeyInfo.keyId}` : undefined);
const perUser = (req: LimitedRequest) => (req.user?.id ? `user:${req.user.id}` : undefined);
const perChannel = (req: LimitedRequest) => {
  const channelId = (req.body as { channel_id?: unknown } | undefined)?.channel_id;
  return typeof channelId === 'string' && SLACK_CHANNEL_ID_PATTERN.test(channelId) ? `channel:${channelId}` : undefined;
};

/**
 * Every window a post must fit before authorization, in order: per key and per user (so one owner's
 * many keys share a cap), each 30 a minute and 1,000 a day. On top of the key's own request limits.
 */
const SLACK_POST_LIMITERS: RequestHandler[] = [
  rateLimit({ limit: SLACK_POSTS_PER_MINUTE, windowMs: MINUTE_MS, bucket: `${BUCKET}:key-minute`, subject: perKey }),
  rateLimit({ limit: SLACK_POSTS_PER_DAY, windowMs: DAY_MS, bucket: `${BUCKET}:key-day`, subject: perKey }),
  rateLimit({ limit: SLACK_POSTS_PER_MINUTE, windowMs: MINUTE_MS, bucket: `${BUCKET}:user-minute`, subject: perUser }),
  rateLimit({ limit: SLACK_POSTS_PER_DAY, windowMs: DAY_MS, bucket: `${BUCKET}:user-day`, subject: perUser }),
];

/**
 * 60 posts a minute per channel, spent only once a post is authorized: if refused requests counted,
 * anyone who knows a channel id could exhaust the window of the org that opted the channel in.
 */
const channelRateLimit = rateLimit({
  limit: SLACK_POSTS_PER_CHANNEL_PER_MINUTE,
  windowMs: MINUTE_MS,
  bucket: `${BUCKET}:channel-minute`,
  subject: perChannel,
});

const spendChannelBudget = (req: LimitedRequest, res: Parameters<RequestHandler>[1]) =>
  new Promise<void>((resolve, reject) => {
    Promise.resolve(channelRateLimit(req, res, error => (error ? reject(error) : resolve()))).catch(reject);
  });

/** Runs the limiters one after another, stopping at the first refusal. */
const slackPostRateLimit: RequestHandler = (req, res, next) => {
  const run = (index: number) => {
    const limiter = SLACK_POST_LIMITERS[index];
    if (!limiter) return next();
    return limiter(req, res, error => (error ? next(error) : run(index + 1)));
  };
  return run(0);
};

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

  const authorization = await authorizeOrgChannelPost({
    channelId,
    userId: req.user.id,
    keyId,
    keyOrgId: req.apiKeyInfo.organizationId,
  });
  if (!authorization.ok) return deny(authorization.reason, authorization.organizationId);
  const { organizationId } = authorization;

  await spendChannelBudget(req, res);

  const botToken = decryptToken(authorization.encryptedBotToken);
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

  try {
    const result = await postOrgSlackMessage(botToken, {
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
