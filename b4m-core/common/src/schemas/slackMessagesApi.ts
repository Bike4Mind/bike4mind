import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { ApiErrorSchema } from './chat';

/**
 * Public wire schema for `POST /api/v1/slack/messages`: post to a Slack channel through the Bike4Mind
 * bot. Public-API rules apply: no `.catch()`, no top-level `.transform()`.
 */

/** Slack truncates a message's top-level `text` well past this; we refuse instead of truncating. */
export const MAX_SLACK_MESSAGE_TEXT_LENGTH = 3000;
/** Slack's own ceiling on blocks per message. */
export const MAX_SLACK_MESSAGE_BLOCKS = 50;
/** Ceiling on the serialized `blocks` array, so one request cannot carry an outsized payload. */
export const MAX_SLACK_MESSAGE_BLOCKS_BYTES = 40_000;

/** A public (`C...`) or private (`G...`) channel id. DMs and user ids are not accepted. */
export const SLACK_CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{8,20}$/;
/** Slack message timestamp, e.g. `1730000000.123456`. */
export const SLACK_MESSAGE_TS_PATTERN = /^\d{10}\.\d{6}$/;

const SlackChannelIdSchema = z
  .string()
  .regex(SLACK_CHANNEL_ID_PATTERN, 'channel_id must be a Slack channel id such as C0123ABCD');

const SlackMessageTsSchema = z
  .string()
  .regex(SLACK_MESSAGE_TS_PATTERN, 'must be a Slack message timestamp such as 1730000000.123456');

/** One Block Kit block. Only `type` is checked here; Slack validates the rest and the route maps its refusal. */
const SlackBlockSchema = z.looseObject({ type: z.string().min(1).max(64) });

export const SlackMessageRequestSchema = z.strictObject({
  channel_id: SlackChannelIdSchema,
  /** Message text; also the notification and accessibility fallback when `blocks` is sent. */
  text: z.string().max(MAX_SLACK_MESSAGE_TEXT_LENGTH).regex(/\S/, 'text must not be blank'),
  blocks: z
    .array(SlackBlockSchema)
    .min(1)
    .max(MAX_SLACK_MESSAGE_BLOCKS)
    .refine(blocks => JSON.stringify(blocks).length <= MAX_SLACK_MESSAGE_BLOCKS_BYTES, {
      message: `blocks must serialize to at most ${MAX_SLACK_MESSAGE_BLOCKS_BYTES} characters`,
    })
    .optional(),
  /** `ts` of the parent message, to reply in its thread. */
  thread_ts: SlackMessageTsSchema.optional(),
});

export type SlackMessageRequest = z.infer<typeof SlackMessageRequestSchema>;

export const SlackMessageResponseSchema = z.object({
  ok: z.literal(true),
  channel_id: z.string(),
  /** The posted message's timestamp; pass it as `thread_ts` to reply in its thread. */
  ts: z.string(),
});

export type SlackMessageResponse = z.infer<typeof SlackMessageResponseSchema>;

/** The `errorCode` values this endpoint sends. */
export const SLACK_MESSAGE_ERROR_CODES = [
  'slack_bot_not_in_channel',
  'slack_channel_archived',
  'provider_rejected',
] as const satisfies readonly ApiErrorCode[];

export const SlackMessageErrorSchema = ApiErrorSchema.extend({
  errorCode: z.enum(SLACK_MESSAGE_ERROR_CODES).optional(),
});
