/**
 * Config Command Handler
 *
 * Handles `/b4m config` - shows the resolved AI model and system prompt
 * for the current channel context.
 */

import { buildSystemPrompt } from '../agent-parser';
import { SYSTEM_MODEL_DEFAULTS } from '../constants/system-model-defaults';
import { getSlackDb } from '../di/registry';
import { SlackClient } from '../SlackClient';
import { Logger } from '@bike4mind/observability';
import { B4mCommandContext, B4mCommandResult } from './types';

/**
 * Resolve the model config for a channel using the same priority chain as CommandHandler:
 * channel config -> org default -> system fallback
 */
async function resolveChannelModelConfig(
  channelId: string,
  organizationId?: string | null
): Promise<{
  modelId: string;
  modelSource: 'channel' | 'org' | 'system';
  temperature: number;
  maxTokens: number;
}> {
  let channelConfig = null;
  let orgDoc = null;

  try {
    const { SlackChannelConfig, Organization } = getSlackDb();
    [channelConfig, orgDoc] = await Promise.all([
      // any: SlackChannelConfig is injected via DI registry without a concrete Mongoose model type
      (SlackChannelConfig as any).findOne({ channelId }).lean(),
      organizationId
        ? // any: Organization is injected via DI registry without a concrete Mongoose model type
          (Organization as any).findById(organizationId).select('preferredModel temperature maxTokens').lean()
        : null,
    ]);
  } catch (err) {
    Logger.globalInstance.warn('[CONFIG] Failed to load channel/org model config, falling back to system defaults', {
      channelId,
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const modelId = channelConfig?.preferredModel || orgDoc?.preferredModel || SYSTEM_MODEL_DEFAULTS.modelId;

  const modelSource: 'channel' | 'org' | 'system' = channelConfig?.preferredModel
    ? 'channel'
    : orgDoc?.preferredModel
      ? 'org'
      : 'system';

  const temperature = channelConfig?.temperature ?? orgDoc?.temperature ?? SYSTEM_MODEL_DEFAULTS.temperature;

  const maxTokens = channelConfig?.maxTokens ?? orgDoc?.maxTokens ?? SYSTEM_MODEL_DEFAULTS.maxTokens;

  return { modelId, modelSource, temperature, maxTokens };
}

/**
 * Format a model ID into a human-readable display name.
 * Returns the ID itself if no friendly name is found.
 */
function formatModelName(modelId: string): string {
  // Known model ID -> display name mappings
  const knownModels: Record<string, string> = {
    // SYSTEM_MODEL_DEFAULTS.modelId is global.anthropic.claude-sonnet-5 -> covers the Bedrock Sonnet 5 id
    [SYSTEM_MODEL_DEFAULTS.modelId]: SYSTEM_MODEL_DEFAULTS.modelDisplayName,
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'global.anthropic.claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'claude-opus-4-8': 'Claude Opus 4.8',
    'claude-opus-4-7': 'Claude Opus 4.7',
    'global.anthropic.claude-opus-4-8': 'Claude Opus 4.8',
    'global.anthropic.claude-opus-4-7': 'Claude Opus 4.7',
    'claude-opus-4-6': 'Claude Opus 4.6',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    'gpt-4.1': 'GPT-4.1',
    'gpt-4.1-mini': 'GPT-4.1 Mini',
    'gpt-4o': 'GPT-4o',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
  };

  return knownModels[modelId] ?? modelId;
}

export async function handleConfigCommand(context: B4mCommandContext): Promise<B4mCommandResult> {
  const { dbUser, channelId, slackUserId, botToken } = context;

  const { modelId, modelSource, temperature, maxTokens } = await resolveChannelModelConfig(
    channelId,
    dbUser.organizationId
  );

  const logger = new Logger({ metadata: { component: 'ConfigCommand' } });
  const slackClient = new SlackClient(botToken, logger);

  try {
    // Build the actual system prompt used for requests in this channel context,
    // including all resource prompts (GitHub, Jira, Confluence)
    const systemPrompt = await buildSystemPrompt({
      user: dbUser,
      slackUserId,
      channelId,
      logger,
    });

    const sourceEmoji: Record<string, string> = {
      channel: '📡',
      org: '🏢',
      system: '⚙️',
    };

    // Open a DM to the invoking user so the system prompt (which contains internal
    // tool definitions, GitHub-to-Slack user mappings, and integration context)
    // is only visible to them - not posted publicly to the channel.
    const dmChannelId = await slackClient.openDmChannel(slackUserId);

    if (dmChannelId) {
      // Upload the full system prompt as a file so users can read it without truncation
      await slackClient.uploadFile({
        channel: dmChannelId,
        filename: 'system-prompt.md',
        content: Buffer.from(systemPrompt, 'utf8'),
        initialComment: `🤖 *B4M AI Configuration*\n*Model:* \`${formatModelName(modelId)}\` ${sourceEmoji[modelSource]} ${modelSource} · *Temp:* ${temperature} · *Max tokens:* ${maxTokens.toLocaleString()}\n\nFull system prompt attached:`,
      });
    }
  } catch (err) {
    logger.error('[CONFIG] Failed to build or deliver config response', {
      error: err instanceof Error ? err.message : String(err),
      slackUserId,
      channelId,
    });

    return {
      response: {
        text: '❌ Failed to retrieve AI configuration. Please try again later.',
        response_type: 'ephemeral',
      },
    };
  }

  // Return empty result - the DM already delivered the message
  return {};
}
