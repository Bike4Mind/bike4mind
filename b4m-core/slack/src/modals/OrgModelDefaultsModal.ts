/**
 * Organization Model Defaults Modal Builder
 *
 * Creates a Slack modal for configuring org-wide AI model defaults.
 */

import type { View } from '@slack/web-api';
import type { IModelConfig } from '@bike4mind/common';
import { buildSlackModelOptionsFromDashboard } from '../constants/slack-model-options';

export const ORG_MODEL_DEFAULTS_CALLBACK_ID = 'org_model_defaults_modal';

export interface OrgModelDefaultsModalParams extends IModelConfig {
  organizationId: string;
}

/**
 * Build the Org Model Defaults modal view
 */
export async function buildOrgModelDefaultsModal(params: OrgModelDefaultsModalParams): Promise<View> {
  const { organizationId, preferredModel, temperature, maxTokens } = params;
  const { option_groups, flat } = await buildSlackModelOptionsFromDashboard();

  return {
    type: 'modal',
    callback_id: ORG_MODEL_DEFAULTS_CALLBACK_ID,
    private_metadata: JSON.stringify({ organizationId }),
    title: {
      type: 'plain_text',
      text: 'Org Model Defaults',
    },
    submit: {
      type: 'plain_text',
      text: 'Save',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'These defaults apply to all channels and agents unless overridden.',
          },
        ],
      },
      ...(option_groups.length > 0
        ? [
            {
              type: 'input' as const,
              block_id: 'model_block',
              label: {
                type: 'plain_text' as const,
                text: 'AI Model',
              },
              element: {
                type: 'static_select' as const,
                action_id: 'model_select',
                placeholder: {
                  type: 'plain_text' as const,
                  text: 'Select a model',
                },
                option_groups,
                ...(() => {
                  const match = preferredModel ? flat.find(o => o.value === preferredModel) : undefined;
                  return match ? { initial_option: match } : {};
                })(),
              },
              optional: true,
            },
          ]
        : [
            {
              type: 'context' as const,
              elements: [
                {
                  type: 'mrkdwn' as const,
                  text: ':warning: No AI models are currently available. Check your LLM API keys and model configurations.',
                },
              ],
            },
          ]),
      {
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
      },
      {
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
      },
    ],
  };
}

export interface OrgModelDefaultsSubmission extends IModelConfig {
  organizationId: string;
}

/**
 * Parse and validate an org model defaults modal submission
 */
export function parseOrgModelDefaultsSubmission(
  values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>,
  privateMetadata: string
): OrgModelDefaultsSubmission | { error: string } {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(privateMetadata);
  } catch {
    return { error: 'Invalid form data. Please close and reopen the dialog.' };
  }
  const organizationId = metadata.organizationId as string;

  if (!organizationId) {
    return { error: 'Missing organization ID.' };
  }

  // Normalize empty string to undefined
  const preferredModel = values.model_block?.model_select?.selected_option?.value || undefined;

  let temperature: number | undefined;
  const tempStr = values.temperature_block?.temperature_input?.value;
  if (tempStr) {
    temperature = parseFloat(tempStr);
    if (isNaN(temperature) || temperature < 0 || temperature > 2) {
      return { error: 'Temperature must be a number between 0 and 2.' };
    }
  }

  let maxTokens: number | undefined;
  const tokStr = values.max_tokens_block?.max_tokens_input?.value;
  if (tokStr) {
    maxTokens = parseInt(tokStr, 10);
    if (isNaN(maxTokens) || maxTokens < 1 || maxTokens > 128000) {
      return { error: 'Max tokens must be between 1 and 128000.' };
    }
  }

  return { organizationId, preferredModel, temperature, maxTokens };
}
