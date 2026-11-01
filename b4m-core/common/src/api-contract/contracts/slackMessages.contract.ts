import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  MAX_SLACK_MESSAGE_BLOCKS,
  MAX_SLACK_MESSAGE_BLOCKS_BYTES,
  MAX_SLACK_MESSAGE_TEXT_LENGTH,
  SlackMessageErrorSchema,
  SlackMessageRequestSchema,
  SlackMessageResponseSchema,
  SLACK_API_POST_BLOCK_TYPES,
} from '../../schemas/slackMessagesApi';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

const EXAMPLE_REQUEST = {
  channel_id: 'C0123ABCDEF',
  text: 'Shipped v1.4.2 to production: 3 changes',
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Shipped v1.4.2 to production*\n- Faster export' } }],
};

/**
 * Contract for POST /api/v1/slack/messages - post to a Slack channel through the Bike4Mind bot.
 *
 * Exists so an external system (a build pipeline, a deploy job) can report status into Slack with a
 * B4M API key, without ever holding a Slack token. Authorization is the scope plus a per-channel
 * opt-in an org owner sets; see apps/client/pages/api/v1/slack/messages.ts.
 */
export const postSlackMessageContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/slack/messages',
  operationId: 'postSlackMessage',
  summary: 'Post a Slack message',
  description:
    'Posts a message to a Slack channel, or a reply in a thread with `thread_ts`, as the Bike4Mind bot. ' +
    'Returns the message `ts`; pass it back as `thread_ts` to reply in that thread. Three things must hold: ' +
    'the key carries `slack:post`; the channel is in a Slack workspace connected to an organization the ' +
    "key's owner belongs to (an organization-billed key must bill that same organization); and an " +
    'organization owner has enabled the channel for API posting, optionally limited to listed key ids. ' +
    'The bot must also be a member of the channel: invite it with `/invite @<bot name>`. ' +
    `\`text\` is at most ${MAX_SLACK_MESSAGE_TEXT_LENGTH} characters and is the notification fallback when ` +
    `\`blocks\` (Block Kit, at most ${MAX_SLACK_MESSAGE_BLOCKS} blocks and ${MAX_SLACK_MESSAGE_BLOCKS_BYTES} ` +
    `serialized characters) is sent. Blocks are limited to ${SLACK_API_POST_BLOCK_TYPES.join(', ')}; nothing a ` +
    'reader can act on is accepted: no interactive elements, `action_id`, `confirm`, or `url` outside a ' +
    'rich_text link, and a section `accessory` must be an image. Broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`, user ' +
    'groups, and bare `@channel` / `@here` / `@everyone`) are posted as plain text that notifies nobody; ' +
    '`<@U...>` user mentions are kept. A block Slack rejects as malformed answers 422. Rate limited to 30 messages a minute and 1,000 a day per key and ' +
    "per user, and 60 a minute per channel, on top of the key's own limits. Authenticate with an API key (`b4m_live_`) carrying `slack:post`.",
  tags: ['Slack'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.SLACK_POST],
  request: SlackMessageRequestSchema,
  requestExample: EXAMPLE_REQUEST,
  responses: {
    200: {
      description: 'The message was posted.',
      schema: SlackMessageResponseSchema,
      example: { ok: true, channel_id: 'C0123ABCDEF', ts: '1730000000.123456' },
    },
    401: {
      description:
        'Missing/invalid credentials, or Slack refused the connected workspace credentials ' +
        '(`errorCode: "provider_rejected"`; an organization owner must reconnect the workspace).',
      schema: SlackMessageErrorSchema,
    },
    403: {
      description:
        'The key lacks `slack:post`, the request was not made with an API key, or the channel is not ' +
        "enabled for API posting by an organization the key's owner belongs to (or not for this key).",
      schema: ScopeForbiddenErrorSchema,
    },
    409: {
      description:
        'The bot is not a member of the channel (`errorCode: "slack_bot_not_in_channel"`; invite it), or ' +
        'the channel is archived (`errorCode: "slack_channel_archived"`).',
      schema: SlackMessageErrorSchema,
    },
    429: {
      description: 'Per-key rate limit exceeded, or Slack is rate limiting the bot. Honor `Retry-After`.',
      schema: ApiErrorSchema,
    },
    502: { description: 'Slack failed to post the message.', schema: ApiErrorSchema },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: EXAMPLE_REQUEST,
  },
});
