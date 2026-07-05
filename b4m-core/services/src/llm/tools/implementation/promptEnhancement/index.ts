import { ToolDefinition } from '../../base/types';

interface PromptEnhancementParams {
  enable?: boolean;
}

const enablePromptEnhancement = async (parameters: PromptEnhancementParams = {}): Promise<string> => {
  const { enable = true } = parameters;

  // This tool is more of a configuration flag - the actual enhancement happens in the image generation API
  if (enable) {
    return 'Prompt enhancement is now enabled for image generation. Your prompts will be automatically optimized for better results.';
  } else {
    return 'Prompt enhancement is now disabled for image generation. Your original prompts will be used directly.';
  }
};

export const promptEnhancementTool: ToolDefinition = {
  name: 'prompt_enhancement',
  implementation: context => ({
    toolFn: async value => {
      const params = value as PromptEnhancementParams;
      context.logger.log('✨ PromptEnhancement: Configuring enhancement', params);

      try {
        const result = await enablePromptEnhancement(params);
        context.logger.log('✅ PromptEnhancement: Configuration updated', { result });
        return result;
      } catch (error) {
        context.logger.error('❌ PromptEnhancement: Configuration failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'prompt_enhancement',
      description:
        'Enable or disable automatic prompt enhancement for image generation. When enabled, your prompts will be optimized to produce better image generation results.',
      parameters: {
        type: 'object',
        properties: {
          enable: {
            type: 'boolean',
            description: 'Whether to enable prompt enhancement for image generation. Defaults to true.',
          },
        },
        additionalProperties: false,
        required: [],
      },
    },
  }),
};
