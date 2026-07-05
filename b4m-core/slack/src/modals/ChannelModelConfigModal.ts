/**
 * Channel Model Config Modal Builder
 *
 * Creates a Slack modal for configuring per-channel AI model settings.
 */

import type { View } from '@slack/web-api';
import type { IModelConfig } from '@bike4mind/common';
import { buildSlackModelOptionsFromDashboard } from '../constants/slack-model-options';

export const CHANNEL_MODEL_CONFIG_CALLBACK_ID = 'channel_model_config_modal';

export interface ChannelModelConfigModalParams extends IModelConfig {
  slackTeamId: string;
  /** When provided, modal operates in edit mode for this channel */
  channelId?: string;
}

/**
 * Build the Channel Model Config modal view
 */
export async function buildChannelModelConfigModal(params: ChannelModelConfigModalParams): Promise<View> {
  const { slackTeamId, channelId, preferredModel, temperature, maxTokens } = params;
  const isEdit = !!channelId;
  const { option_groups, flat } = await buildSlackModelOptionsFromDashboard();

  const blocks: View['blocks'] = [];

  // Channel selector (only for new configs)
  if (!isEdit) {
    blocks.push({
      type: 'input',
      block_id: 'channel_block',
      label: {
        type: 'plain_text',
        text: 'Channel',
      },
      element: {
        type: 'channels_select',
        action_id: 'channel_select',
        placeholder: {
          type: 'plain_text',
          text: 'Select a channel',
        },
      },
    });
  }

  // Model selector (or warning if no models available)
  if (option_groups.length > 0) {
    blocks.push({
      type: 'input',
      block_id: 'model_block',
      label: {
        type: 'plain_text',
        text: 'AI Model',
      },
      element: {
        type: 'static_select',
        action_id: 'model_select',
        placeholder: {
          type: 'plain_text',
          text: 'Select a model',
        },
        option_groups,
        ...(() => {
          const match = preferredModel ? flat.find(o => o.value === preferredModel) : undefined;
          return match ? { initial_option: match } : {};
        })(),
      },
      optional: true,
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':warning: No AI models are currently available. Check your LLM API keys and model configurations.',
        },
      ],
    });
  }

  // Temperature input
  blocks.push({
    type: 'input',
    block_id: 'temperature_block',
    label: {
      type: 'plain_text',
      text: 'Temperature (0-2)',
    },
    element: {
      type: 'plain_text_input',
      action_id: 'temperature_input',
      placeholder: {
        type: 'plain_text',
        text: 'e.g. 0.9',
      },
      ...(temperature !== undefined && {
        initial_value: String(temperature),
      }),
    },
    optional: true,
  });

  // Max tokens input
  blocks.push({
    type: 'input',
    block_id: 'max_tokens_block',
    label: {
      type: 'plain_text',
      text: 'Max Tokens',
    },
    element: {
      type: 'plain_text_input',
      action_id: 'max_tokens_input',
      placeholder: {
        type: 'plain_text',
        text: 'e.g. 4000',
      },
      ...(maxTokens !== undefined && {
        initial_value: String(maxTokens),
      }),
    },
    optional: true,
  });

  return {
    type: 'modal',
    callback_id: CHANNEL_MODEL_CONFIG_CALLBACK_ID,
    private_metadata: JSON.stringify({ slackTeamId, channelId }),
    title: {
      type: 'plain_text',
      text: isEdit ? 'Edit Channel Config' : 'Channel Config',
    },
    submit: {
      type: 'plain_text',
      text: 'Save',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    blocks,
  };
}

export interface ChannelModelConfigSubmission extends IModelConfig {
  channelId: string;
  slackTeamId: string;
}

/**
 * Parse and validate a channel model config modal submission
 */
export function parseChannelModelConfigSubmission(
  values: Record<
    string,
    Record<string, { value?: string; selected_option?: { value: string }; selected_channel?: string }>
  >,
  privateMetadata: string
): ChannelModelConfigSubmission | { error: string } {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(privateMetadata);
  } catch {
    return { error: 'Invalid form data. Please close and reopen the dialog.' };
  }
  const slackTeamId = metadata.slackTeamId as string;

  if (!slackTeamId) {
    return { error: 'Missing workspace ID. Please close and reopen the dialog.' };
  }

  // Channel: from selector or from metadata (edit mode)
  const channelId = (metadata.channelId as string) || values.channel_block?.channel_select?.selected_channel;

  if (!channelId) {
    return { error: 'Please select a channel.' };
  }

  // Basic Slack channel ID format validation (starts with C, D, or G)
  if (!/^[CDG][A-Z0-9]+$/.test(channelId)) {
    return { error: 'Invalid channel ID format.' };
  }

  // Model (normalize empty string to undefined)
  const preferredModel = values.model_block?.model_select?.selected_option?.value || undefined;

  // Temperature
  let temperature: number | undefined;
  const tempStr = values.temperature_block?.temperature_input?.value;
  if (tempStr) {
    temperature = parseFloat(tempStr);
    if (isNaN(temperature) || temperature < 0 || temperature > 2) {
      return { error: 'Temperature must be a number between 0 and 2.' };
    }
  }

  // Max tokens
  let maxTokens: number | undefined;
  const tokStr = values.max_tokens_block?.max_tokens_input?.value;
  if (tokStr) {
    maxTokens = parseInt(tokStr, 10);
    if (isNaN(maxTokens) || maxTokens < 1 || maxTokens > 128000) {
      return { error: 'Max tokens must be between 1 and 128000.' };
    }
  }

  return { channelId, slackTeamId, preferredModel, temperature, maxTokens };
}
