import { Logger } from '@bike4mind/observability';
import { ChatModels, IMessage, type ModelInfo, ModelBackend } from '@bike4mind/common';
import { ChoiceEndReason, ChoiceStatus, ICompletionOptions, ICompletionResponseChunk } from '../backend';
import { BaseBedrockBackend } from './base';

export default class LlamaBedrockBackend extends BaseBedrockBackend {
  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.LLAMA3_INSTRUCT_8B_V1,
        type: 'text',
        name: 'Llama 3 Instruct 8B',
        backend: ModelBackend.Bedrock,
        contextWindow: 8000,
        supportsImageVariation: false,
        max_tokens: 2048,
        can_stream: true,
        pricing: {
          8000: { input: 0.0003 / 1000, output: 0.0006 / 1000 }, // $0.0003 / 1,000 Input tokens, $0.0006 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },
        supportsVision: false,
        logoFile: '512px-Meta-Logo.svg',
        rank: 5,
        description:
          "Meta\'s open-source Llama 3 model with 8B parameters. Optimized for high-volume tasks requiring good reasoning capabilities.",
      },
      {
        id: ChatModels.LLAMA3_INSTRUCT_70B_V1,
        type: 'text',
        name: 'Llama 3 Instruct 70B',
        backend: ModelBackend.Bedrock,
        contextWindow: 8000,
        supportsImageVariation: false,
        max_tokens: 2048,
        can_stream: true,
        pricing: {
          8000: { input: 0.00265 / 1000, output: 0.0035 / 1000 }, // $0.00265 / 1,000 Input tokens, $0.0035 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },
        supportsVision: false,
        logoFile: '512px-Meta-Logo.svg',
        rank: 4,
        description:
          "Meta's powerful open-source Llama 3 model with 70B parameters. Excellent performance comparable to proprietary models with local deployment flexibility.",
      },

      // Llama 4 models
      {
        id: ChatModels.LLAMA4_MAVERICK_17B_INSTRUCT_BEDROCK,
        type: 'text',
        name: 'Llama 4 Maverick 17B Instruct',
        backend: ModelBackend.Bedrock,
        contextWindow: 8000,
        supportsImageVariation: false,
        max_tokens: 2048,
        can_stream: true,
        pricing: {
          8000: { input: 0.001 / 1000, output: 0.002 / 1000 }, // Placeholder pricing - update with public rates
        },
        supportsVision: false,
        logoFile: '512px-Meta-Logo.svg',
        rank: 3,
        trainingCutoff: '2025-05-01',
        description:
          'Llama 4 Maverick 17B via AWS Bedrock. Optimized for fast, efficient inference with strong instruction following. Routes across us-east-1, us-east-2, us-west-2.',
      },
      {
        id: ChatModels.LLAMA4_SCOUT_17B_INSTRUCT_BEDROCK,
        type: 'text',
        name: 'Llama 4 Scout 17B Instruct',
        backend: ModelBackend.Bedrock,
        contextWindow: 8000,
        supportsImageVariation: false,
        max_tokens: 2048,
        can_stream: true,
        pricing: {
          8000: { input: 0.001 / 1000, output: 0.002 / 1000 }, // Placeholder pricing - update with public rates
        },
        supportsVision: false,
        logoFile: '512px-Meta-Logo.svg',
        rank: 3,
        trainingCutoff: '2025-05-01',
        description:
          'Llama 4 Scout 17B via AWS Bedrock. Specialized for exploration and reasoning tasks with enhanced analytical capabilities. Routes across us-east-1, us-east-2, us-west-2.',
      },
    ];
  }

  getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): { modelId: string; contentType: string; accept: string; body: string } {
    // AWS Bedrock Llama models use a simple prompt format, not chat templates
    // Convert messages to a simple conversation format
    let prompt = '';

    for (const message of messages) {
      if (message.role === 'system') {
        prompt += `System: ${message.content}\n\n`;
      } else if (message.role === 'user') {
        prompt += `Human: ${message.content}\n\n`;
      } else if (message.role === 'assistant') {
        prompt += `Assistant: ${message.content}\n\n`;
      }
    }

    // Add the assistant prompt to start the response
    prompt += 'Assistant:';

    // Add stop sequences to prevent the model from continuing the conversation artificially
    const stopSequences = ['Human:', '\nHuman:', '\n\nHuman:', 'Assistant:', '\nAssistant:'];

    const payload = {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        prompt: prompt,
        temperature: options.temperature || 0.7,
        top_p: options.topP || 0.9,
        max_gen_len: options.maxTokens || 2048,
        stop: stopSequences,
      }),
    };
    return payload;
  }

  formatTools(tools: ICompletionOptions['tools']) {
    throw new Error('Bedrock Llama: format tools method not yet supported.');
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  translateChunk(model: string, chunk: Record<string, unknown>): { done: boolean; chunk: ICompletionResponseChunk } {
    try {
      // Parse the response from Llama API
      const response = chunk as {
        generation: string;
        prompt_token_count: number;
        generation_token_count: number;
        stop_reason: string;
      };

      // Create a choice object with the extracted text
      return {
        done: true,
        chunk: {
          model,
          choices: [
            {
              status: ChoiceStatus.END,
              statusEndReason: ChoiceEndReason.COMPLETE,
              index: 0,
              chunkText: response.generation || '',
              usage: {
                input_tokens: response.prompt_token_count || 0,
                output_tokens: response.generation_token_count || 0,
              },
            },
          ],
        },
      };
    } catch (error) {
      Logger.globalInstance.error('[LlamaBedrockBackend] Error translating non-streaming chunk:', error);
      throw error;
    }
  }

  translateStreamChunk(
    model: string,
    chunk: Record<string, unknown>
  ): { done: boolean; chunk: ICompletionResponseChunk } {
    return {
      done: !!chunk.stop_reason,
      chunk: {
        model,
        choices: [
          {
            chunkText: chunk.generation as string,
            index: 0,
            status: ChoiceStatus.END,
            statusEndReason: ChoiceEndReason.STOP,
          },
        ],
      },
    };
  }

  pushToolMessages(
    messages: IMessage[],
    _tool: { name: string; id: string; parameters: string },
    _result: string,
    _thinkingBlocks?: unknown[]
  ): unknown {
    return messages;
  }
}
