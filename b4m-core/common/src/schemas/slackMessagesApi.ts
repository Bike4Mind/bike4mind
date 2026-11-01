import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { ApiErrorSchema } from './chat';

/**
 * Public wire schema for `POST /api/v1/slack/messages`: post to a Slack channel through the Bike4Mind
 * bot. Public-API rules apply: no `.catch()`, no top-level `.transform()`.
 */

/** Slack truncates a message's top-level `text` well past this; we refuse instead of truncating. */
export const MAX_SLACK_MESSAGE_TEXT_LENGTH = 3000;
/** Slack allows 50 blocks per message; the server appends one attribution block, so callers get 49. */
export const MAX_SLACK_MESSAGE_BLOCKS = 49;
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

/** Block types a caller may send: layout and content only, never anything a reader can click to act. */
export const SLACK_API_POST_BLOCK_TYPES = ['section', 'header', 'divider', 'context', 'image', 'rich_text'] as const;
/** Nesting depth and node count ceilings for `blocks`, checked iteratively before anything recurses over it. */
export const MAX_SLACK_MESSAGE_BLOCKS_DEPTH = 12;
export const MAX_SLACK_MESSAGE_BLOCKS_NODES = 5000;

/**
 * `event_type` of the metadata the server attaches to every API post. The Slack interactivity handler
 * refuses any action on a message carrying it (apps/client/pages/api/slack/interactive.ts).
 */
export const SLACK_API_POST_EVENT_TYPE = 'b4m_api_post';

const ALLOWED_BLOCK_TYPES: ReadonlySet<string> = new Set(SLACK_API_POST_BLOCK_TYPES);
// Element types a reader can act on. Slack generates an action_id when one is omitted, so these are
// refused by type as well as by the presence of action_id.
const INTERACTIVE_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  'actions',
  'input',
  'button',
  'workflow_button',
  'overflow',
  'datepicker',
  'timepicker',
  'datetimepicker',
  'checkboxes',
  'radio_buttons',
  'static_select',
  'external_select',
  'users_select',
  'conversations_select',
  'channels_select',
  'multi_static_select',
  'multi_external_select',
  'multi_users_select',
  'multi_conversations_select',
  'multi_channels_select',
  'plain_text_input',
  'email_text_input',
  'url_text_input',
  'number_input',
  'file_input',
  'rich_text_input',
]);
// Keys that make an element act or navigate. `url` is allowed only on a rich_text `link`, which is
// the same plain hyperlink mrkdwn `<https://...|text>` already allows in text.
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['action_id', 'confirm', 'url', 'dispatch_action']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Returns why `blocks` may not be posted, or null when it may. Iterative, so a deeply nested body is
 * refused instead of overflowing the stack: blocks are limited to {@link SLACK_API_POST_BLOCK_TYPES},
 * and no node anywhere may be an interactive element or carry `action_id`, `confirm` or `url` (except
 * a rich_text link). A section `accessory` may only be an image.
 */
export function findSlackApiPostBlocksProblem(blocks: readonly unknown[]): string | null {
  for (const [index, block] of blocks.entries()) {
    const type = isRecord(block) ? block.type : undefined;
    if (typeof type !== 'string' || !ALLOWED_BLOCK_TYPES.has(type)) {
      return `blocks[${index}].type must be one of ${SLACK_API_POST_BLOCK_TYPES.join(', ')}`;
    }
  }

  const stack: Array<{ value: unknown; depth: number; path: string }> = blocks.map((value, index) => ({
    value,
    depth: 1,
    path: `blocks[${index}]`,
  }));
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth, path } = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_SLACK_MESSAGE_BLOCKS_NODES)
      return `blocks may hold at most ${MAX_SLACK_MESSAGE_BLOCKS_NODES} values`;
    if (depth > MAX_SLACK_MESSAGE_BLOCKS_DEPTH)
      return `blocks may nest at most ${MAX_SLACK_MESSAGE_BLOCKS_DEPTH} levels`;

    if (Array.isArray(value)) {
      value.forEach((child, i) => stack.push({ value: child, depth: depth + 1, path: `${path}[${i}]` }));
      continue;
    }
    if (!isRecord(value)) continue;

    if (typeof value.type === 'string' && INTERACTIVE_ELEMENT_TYPES.has(value.type)) {
      return `${path}: interactive elements (${value.type}) are not allowed`;
    }
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key) && !(key === 'url' && value.type === 'link')) {
        return `${path}.${key} is not allowed`;
      }
      if (key === 'accessory' && !(isRecord(child) && child.type === 'image')) {
        return `${path}.accessory may only be an image`;
      }
      stack.push({ value: child, depth: depth + 1, path: `${path}.${key}` });
    }
  }
  return null;
}

/** Distinct users one post may mention: past this, individual mentions add up to a broadcast. */
export const MAX_SLACK_MESSAGE_USER_MENTIONS = 10;
const USER_MENTION_FORM = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/gi;

/**
 * Counts the distinct users a post mentions: mrkdwn `<@U...>` in `text` or any string of `blocks`, and
 * rich_text `user` elements. Iterative, so it is safe on a body the blocks checks have not yet refused.
 */
export function countSlackUserMentions(text: string, blocks: readonly unknown[] = []): number {
  const users = new Set<string>();
  const collect = (value: string) => {
    for (const match of value.matchAll(USER_MENTION_FORM)) users.add(match[1].toUpperCase());
  };
  collect(text);
  const stack: unknown[] = [...blocks];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      collect(value);
    } else if (Array.isArray(value)) {
      for (const child of value) stack.push(child);
    } else if (isRecord(value)) {
      if (value.type === 'user' && typeof value.user_id === 'string') users.add(value.user_id.toUpperCase());
      for (const child of Object.values(value)) stack.push(child);
    }
  }
  return users.size;
}

/** One Block Kit block; the whole array is checked by findSlackApiPostBlocksProblem. */
const SlackBlockSchema = z.looseObject({ type: z.string().min(1).max(64) });

export const SlackMessageRequestSchema = z
  .strictObject({
    channel_id: SlackChannelIdSchema,
    /** Message text; also the notification and accessibility fallback when `blocks` is sent. */
    text: z.string().max(MAX_SLACK_MESSAGE_TEXT_LENGTH).regex(/\S/, 'text must not be blank'),
    blocks: z
      .array(SlackBlockSchema)
      .min(1)
      .max(MAX_SLACK_MESSAGE_BLOCKS)
      .superRefine((blocks, ctx) => {
        // Structure first: it bounds depth and size, so the stringify below cannot overflow the stack.
        const problem = findSlackApiPostBlocksProblem(blocks);
        if (problem) {
          ctx.addIssue({ code: 'custom', message: problem });
          return;
        }
        if (JSON.stringify(blocks).length > MAX_SLACK_MESSAGE_BLOCKS_BYTES) {
          ctx.addIssue({
            code: 'custom',
            message: `blocks must serialize to at most ${MAX_SLACK_MESSAGE_BLOCKS_BYTES} characters`,
          });
        }
      })
      .optional(),
    /** `ts` of the parent message, to reply in its thread. */
    thread_ts: SlackMessageTsSchema.optional(),
  })
  .superRefine(({ text, blocks }, ctx) => {
    if (typeof text !== 'string') return;
    if (countSlackUserMentions(text, Array.isArray(blocks) ? blocks : []) > MAX_SLACK_MESSAGE_USER_MENTIONS) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: `a message may mention at most ${MAX_SLACK_MESSAGE_USER_MENTIONS} distinct users`,
      });
    }
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
  'slack_channel_restricted',
  'provider_rejected',
] as const satisfies readonly ApiErrorCode[];

export const SlackMessageErrorSchema = ApiErrorSchema.extend({
  errorCode: z.enum(SLACK_MESSAGE_ERROR_CODES).optional(),
});
