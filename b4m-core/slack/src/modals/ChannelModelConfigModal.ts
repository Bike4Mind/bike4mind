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
  /** Default GitHub owner for issue creation without an explicit repo */
  githubOwner?: string;
  /** Default GitHub repo for issue creation without an explicit repo */
  githubRepo?: string;
}

/**
 * Build the Channel Model Config modal view
 */
export async function buildChannelModelConfigModal(params: ChannelModelConfigModalParams): Promise<View> {
  const { slackTeamId, channelId, preferredModel, temperature, maxTokens, githubOwner, githubRepo } = params;
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

  // Default GitHub repository (owner + repo) for issue creation from this channel
  blocks.push({
    type: 'input',
    block_id: 'github_owner_block',
    label: {
      type: 'plain_text',
      text: 'Default GitHub Owner',
    },
    element: {
      type: 'plain_text_input',
      action_id: 'github_owner_input',
      placeholder: {
        type: 'plain_text',
        text: 'e.g. my-org',
      },
      ...(githubOwner && {
        initial_value: githubOwner,
      }),
    },
    hint: {
      type: 'plain_text',
      text: 'Used when someone creates a GitHub issue without naming a repo.',
    },
    optional: true,
  });

  blocks.push({
    type: 'input',
    block_id: 'github_repo_block',
    label: {
      type: 'plain_text',
      text: 'Default GitHub Repository',
    },
    element: {
      type: 'plain_text_input',
      action_id: 'github_repo_input',
      placeholder: {
        type: 'plain_text',
        text: 'e.g. my-repo',
      },
      ...(githubRepo && {
        initial_value: githubRepo,
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
  githubOwner?: string;
  githubRepo?: string;
}

// GitHub owner (user/org): alphanumeric + hyphens, no leading/trailing hyphen, max 39 chars
const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
// GitHub repo name: alphanumeric, hyphens, underscores, dots, max 100 chars
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

/**
 * Parse and validate a channel model config modal submission
 */
export function parseChannelModelConfigSubmission(
  values: Record<
    string,
    Record<string, { value?: string; selected_option?: { value: string }; selected_channel?: string }>
  >,
  privateMetadata: string
): ChannelModelConfigSubmission | { error: string; errorBlock?: string } {
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

  // Default GitHub repository (normalize empty strings to undefined)
  const githubOwner = values.github_owner_block?.github_owner_input?.value?.trim() || undefined;
  const githubRepo = values.github_repo_block?.github_repo_input?.value?.trim() || undefined;

  if (githubOwner && !GITHUB_OWNER_REGEX.test(githubOwner)) {
    return {
      error: 'GitHub owner must be a valid GitHub username or organization (e.g. "my-org").',
      errorBlock: 'github_owner_block',
    };
  }
  if (githubRepo && !GITHUB_REPO_REGEX.test(githubRepo)) {
    return {
      error: 'GitHub repository must be a valid repo name (e.g. "my-repo"), without the owner prefix.',
      errorBlock: 'github_repo_block',
    };
  }
  if (!!githubOwner !== !!githubRepo) {
    return {
      error: 'Please provide both a GitHub owner and repository, or leave both empty.',
      errorBlock: githubOwner ? 'github_repo_block' : 'github_owner_block',
    };
  }

  return { channelId, slackTeamId, preferredModel, temperature, maxTokens, githubOwner, githubRepo };
}
