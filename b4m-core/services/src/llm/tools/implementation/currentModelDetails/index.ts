import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { ToolDefinition } from '../../base/types';

export const CURRENT_MODEL_DETAILS_TOOL_NAME = 'current_model_details';

const BACKEND_LABELS: Partial<Record<ModelBackend, string>> = {
  [ModelBackend.Anthropic]: 'direct Anthropic API',
  [ModelBackend.Bedrock]: 'AWS Bedrock',
  [ModelBackend.Ollama]: 'local Ollama',
};

// Fields are picked explicitly: ModelInfo carries per-token pricing, which is not ours to expose.
const describeModel = (model: ModelInfo) => ({
  name: model.name,
  id: model.id,
  backend: model.backend,
  servedVia: BACKEND_LABELS[model.backend] ?? model.backend,
  contextWindow: model.contextWindow,
  // A derived max_tokens is a placeholder default, not the model's real ceiling: say nothing.
  maxTokens: model.maxOutputTokensDerived ? undefined : model.max_tokens,
  capabilities: {
    supportsTools: model.supportsTools ?? false,
    supportsVision: model.supportsVision ?? false,
    canStream: model.can_stream ?? false,
    canThink: model.can_think ?? false,
    thinkingStyle: model.thinkingStyle,
  },
});

export const currentModelDetailsTool: ToolDefinition = {
  name: CURRENT_MODEL_DETAILS_TOOL_NAME,
  implementation: context => ({
    toolFn: async () => {
      // Read at call time: servingModel moves when the turn falls back to another model.
      const model = context.servingModel?.current ?? context.availableModels?.find(m => m.id === context.model);
      if (!model) return 'Model details are unavailable for this turn.';
      return JSON.stringify(describeModel(model));
    },
    toolSchema: {
      name: CURRENT_MODEL_DETAILS_TOOL_NAME,
      description:
        'Get the details of the AI model serving this conversation right now: its name, id, provider, context window, max output tokens and capabilities. Call this whenever asked which model you are, what version you are, or what you can do - never answer from memory.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
        required: [],
      },
    },
  }),
};
