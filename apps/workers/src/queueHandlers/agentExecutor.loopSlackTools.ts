/**
 * `loop_slack_post`: lets a loop run post to its loop's `slackChannelId`, an org channel opted in for API posting
 * (packages/server-utils/src/integrations/slack/orgChannelPost.ts holds the rules it shares with
 * POST /api/v1/slack/messages). Offered only when the loop has a channel; appended and pre-approved like the
 * `loop_ticket_*` tools (agentExecutor.loopTicketTools.ts).
 */
import {
  escapeSlackLine,
  LOOP_SLACK_TOOL_NAMES,
  neutralizeSlackBroadcastMentions,
  SLACK_API_POST_EVENT_TYPE,
} from '@bike4mind/common';
import { cacheRepository, loopRepository, userRepository } from '@bike4mind/database';
import type { ToolDefinition } from '@bike4mind/services/llm';
import { BadRequestError } from '@bike4mind/utils';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import {
  authorizeOrgChannelPost,
  postOrgSlackMessage,
  spendSlackChannelBudget,
  toCallerError,
} from '@bike4mind/server-utils/integrations/slack/orgChannelPost';
import { asToolResult } from './agentExecutor.loopTicketTools';

export const MAX_SLACK_POSTS_PER_RUN = 3;
const TEXT_MAX = 3000;
const NAME_MAX = 80;
/** Long enough to outlast any run and its continuations. */
const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LoopSlackToolContribution {
  loopSlackEnabledTools: readonly string[];
  loopSlackExternalTools: Record<string, ToolDefinition>;
}

export async function resolveLoopSlackTools({
  loopId,
  loopsEnabled,
  userId,
  executionId,
}: {
  loopId?: string;
  loopsEnabled: boolean;
  userId: string;
  executionId: string;
}): Promise<LoopSlackToolContribution> {
  const none = { loopSlackEnabledTools: [], loopSlackExternalTools: {} };
  if (!loopId || !loopsEnabled) return none;
  if (!(await loopRepository.findByIdAndUserId(loopId, userId))?.slackChannelId) return none;
  return {
    loopSlackEnabledTools: LOOP_SLACK_TOOL_NAMES,
    loopSlackExternalTools: { loop_slack_post: buildLoopSlackPost({ loopId, userId, executionId }) },
  };
}

const NOT_ENABLED =
  "the loop's Slack channel is not opted in for posting by its organization (or only allows specific API keys); the owner must fix it";

export function buildLoopSlackPost({
  loopId,
  userId,
  executionId,
}: {
  loopId: string;
  userId: string;
  executionId: string;
}): ToolDefinition {
  return {
    name: 'loop_slack_post',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          const params = (value ?? {}) as { text?: unknown };
          const text = typeof params.text === 'string' ? params.text.trim() : '';
          if (!text) throw new BadRequestError('text is required');
          if (text.length > TEXT_MAX) throw new BadRequestError(`text must be ${TEXT_MAX} characters or fewer`);

          // Re-read per call, so an owner edit (channel removed, org changed) applies mid-run.
          const loop = await loopRepository.findByIdAndUserId(loopId, userId);
          const channelId = loop?.slackChannelId;
          if (!loop || !channelId) throw new BadRequestError('this loop has no Slack channel');
          const authorization = await authorizeOrgChannelPost({ channelId, userId });
          if (!authorization.ok || authorization.organizationId !== loop.organizationId) {
            throw new BadRequestError(NOT_ENABLED);
          }
          // Counted per run in the cache, so it holds across continuations.
          const { success } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
            `loop-slack:${executionId}`,
            MAX_SLACK_POSTS_PER_RUN,
            RUN_WINDOW_MS
          );
          if (!success) throw new BadRequestError(`at most ${MAX_SLACK_POSTS_PER_RUN} Slack posts per run`);
          if (!(await spendSlackChannelBudget(channelId))) {
            throw new BadRequestError('the channel is busy; it takes at most 60 posts a minute');
          }
          const botToken = decryptToken(authorization.encryptedBotToken);
          if (!botToken) throw new BadRequestError("the organization's Slack connection needs reconnecting");

          const owner = (await userRepository.findById(userId))?.name || 'its owner';
          const clip = (name: string) => escapeSlackLine(name.slice(0, NAME_MAX));
          const posted = neutralizeSlackBroadcastMentions(text);
          try {
            const result = await postOrgSlackMessage(botToken, {
              channel: channelId,
              text: posted,
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: posted } },
                {
                  type: 'context',
                  elements: [{ type: 'mrkdwn', text: `Posted by loop ${clip(loop.name)} on behalf of ${clip(owner)}` }],
                },
              ],
              // Marks the message as API-posted, so the interactivity handler refuses any action on it.
              metadata: { event_type: SLACK_API_POST_EVENT_TYPE, event_payload: { loop_id: loopId, user_id: userId } },
            });
            return { posted: true, ts: result.ts };
          } catch (error) {
            throw new BadRequestError(toCallerError(error).error.message);
          }
        }),
      toolSchema: {
        name: 'loop_slack_post',
        description: `Post a message to this loop's Slack channel, for example what this run shipped. Attributed to this loop and its owner; @channel and @here are disabled. At most ${MAX_SLACK_POSTS_PER_RUN} posts per run.`,
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: `Slack mrkdwn text (${TEXT_MAX.toLocaleString('en-US')} characters max).`,
            },
          },
          required: ['text'],
        },
      },
    }),
  };
}
