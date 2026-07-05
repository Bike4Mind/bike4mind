import { ImageModels } from '@bike4mind/common';
import type { SlackBlockKitElement } from './confirmation-buttons';

/**
 * Image model display metadata for the Slack model picker UI
 */
interface ImageModelOption {
  model: ImageModels;
  emoji: string;
  label: string;
  description: string;
  /** If true, this button gets the 'primary' (green) style */
  recommended?: boolean;
}

const IMAGE_MODEL_OPTIONS: ImageModelOption[] = [
  {
    model: ImageModels.GPT_IMAGE_1_5,
    emoji: '\u26A1',
    label: 'GPT-Image',
    description: 'Fast, reliable',
  },
  {
    model: ImageModels.FLUX_PRO_1_1,
    emoji: '\uD83D\uDD8C\uFE0F',
    label: 'Flux Pro',
    description: 'High quality',
  },
  {
    model: ImageModels.FLUX_PRO_ULTRA,
    emoji: '\u2728',
    label: 'Flux Ultra',
    description: 'Best quality',
  },
];

/**
 * Action ID used for all image model picker buttons.
 * The `value` field differentiates the model selection.
 */
export const IMAGE_GEN_MODEL_ACTION_ID = 'image_gen_model';

/**
 * Build a Block Kit model picker for image generation.
 *
 * @param questId - Quest ID to reference when the user picks a model
 * @param prompt - The user's image generation prompt (for display)
 * @returns Array of Slack Block Kit elements
 */
export function buildImageModelPicker(questId: string, prompt: string): SlackBlockKitElement[] {
  // Truncate prompt for display (Slack section text limit is 3000 chars)
  const displayPrompt = prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt;

  const blocks: SlackBlockKitElement[] = [];

  // Prompt display
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*\uD83C\uDFA8 Image Generation*\n> ${displayPrompt}`,
    },
  });

  blocks.push({ type: 'divider' });

  // Model selection buttons - each needs a unique action_id (Slack Block Kit requirement).
  // Interactive handler matches via action_id.startsWith(IMAGE_GEN_MODEL_ACTION_ID)
  blocks.push({
    type: 'actions',
    elements: IMAGE_MODEL_OPTIONS.map((opt, idx) => ({
      type: 'button' as const,
      text: {
        type: 'plain_text' as const,
        text: `${opt.emoji} ${opt.label}`,
        emoji: true,
      },
      ...(opt.recommended ? { style: 'primary' as const } : {}),
      action_id: `${IMAGE_GEN_MODEL_ACTION_ID}_${idx}`,
      value: `${questId}:${opt.model}`,
    })),
  });

  // Context block with model descriptions
  const descriptions = IMAGE_MODEL_OPTIONS.map(opt => `${opt.emoji} *${opt.label}* \u2014 ${opt.description}`).join(
    '  |  '
  );
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: descriptions }],
  });

  return blocks;
}

/**
 * Get human-readable display name for an image model
 */
export function getImageModelDisplayName(model: ImageModels): string {
  const option = IMAGE_MODEL_OPTIONS.find(opt => opt.model === model);
  if (option) return `${option.emoji} ${option.label}`;

  // Fallback for models not in the picker
  return model;
}
