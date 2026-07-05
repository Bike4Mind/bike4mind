import { Logger } from '@bike4mind/observability';
import { IMessage, type ModelInfo } from '@bike4mind/common';
import { ChoiceEndReason, ChoiceStatus, ICompletionOptions, ICompletionResponseChunk } from '../backend';
import { BaseBedrockBackend } from './base';

interface TitanResultElement {
  tokenCount: number;
  outputText: string;
  completionReason: 'FINISH' | 'LENGTH' | 'CONTENT_FILTERED';
}

interface TitanChunk {
  index: number;
  inputTextTokenCount: number;
  totalOutputTokenCount: number;
  outputText: string;
  completionReason: 'FINISH' | 'LENGTH' | 'CONTENT_FILTERED';
}

export default class TitanBedrockBackend extends BaseBedrockBackend {
  async getModelInfo(): Promise<ModelInfo[]> {
    // Amazon end-of-lifed amazon.titan-text-express-v1 and amazon.titan-text-lite-v1 on Bedrock;
    // invoking them now returns a hard ResourceNotFoundException (HTTP 404). Returning no models
    // here drops them from getAvailableModels(), so they can no longer be selected. Any session
    // still configured to one of these IDs then fails fast at the request-time availability check
    // (ChatCompletionInvoke) with a clean "model is not available" error instead of a raw Bedrock
    // 404 - and stops paging LiveOps. The ChatModels enum members are intentionally retained:
    // supportedChatModels (z.enum(ChatModels)) validates persisted agent.preferredModel and action
    // summaryModelId values, so dropping the enum entries would reject historical records that
    // still reference these IDs.
    return [];
  }

  private cleanContent(content: string): string {
    // Remove XML-like role tags that may exist in historical messages
    // This handles tags like <bot>, <Bot>, <assistant>, <user>, <system>, etc.
    return content
      .replace(/<\/?bot>/gi, '')
      .replace(/<\/?assistant>/gi, '')
      .replace(/<\/?user>/gi, '')
      .replace(/<\/?system>/gi, '')
      .trim();
  }

  getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): { modelId: string; contentType: string; accept: string; body: string } {
    // Convert messages to a simple conversation format without XML tags
    // Similar to Llama's format but adapted for Titan
    let prompt = '';

    for (const message of messages) {
      const rawContent = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      // Clean any XML tags from historical messages
      const content = this.cleanContent(rawContent);

      if (message.role === 'system') {
        prompt += `System: ${content}\n\n`;
      } else if (message.role === 'user') {
        prompt += `User: ${content}\n\n`;
      } else if (message.role === 'assistant') {
        prompt += `Assistant: ${content}\n\n`;
      }
    }

    // Add the assistant prompt to start the response
    prompt += 'Assistant:';

    // Build textGenerationConfig with only defined values
    const textGenerationConfig: Record<string, unknown> = {};

    if (typeof options.temperature === 'number') {
      textGenerationConfig.temperature = options.temperature;
    }

    if (typeof options.topP === 'number') {
      textGenerationConfig.topP = options.topP;
    }

    if (typeof options.maxTokens === 'number') {
      textGenerationConfig.maxTokenCount = options.maxTokens;
    }

    // Only include stopSequences if provided
    if (options.stop && Array.isArray(options.stop) && options.stop.length > 0) {
      textGenerationConfig.stopSequences = options.stop;
    }

    const payload = {
      inputText: prompt,
      textGenerationConfig,
    };

    Logger.globalInstance.log('[TitanBedrockBackend] Request payload:', JSON.stringify(payload, null, 2));

    return {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    };
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  translateChunk(model: string, chunk: Record<string, unknown>): { done: boolean; chunk: ICompletionResponseChunk } {
    try {
      // Parse the response from Titan API
      const response = chunk as {
        results: Array<TitanResultElement>;
        inputTextTokenCount?: number;
      };

      return {
        done: true,
        chunk: {
          model,
          choices: (response.results || []).map((result, index) => ({
            status: ChoiceStatus.END,
            statusEndReason: ChoiceEndReason.COMPLETE,
            index,
            chunkText: result.outputText || '',
            usage: {
              input_tokens: response.inputTextTokenCount || 0,
              output_tokens: result.tokenCount || 0,
            },
          })),
        },
      };
    } catch (error) {
      Logger.globalInstance.error('[TitanBedrockBackend] Error translating non-streaming chunk:', error);
      throw error;
    }
  }

  translateStreamChunk(
    model: string,
    chunk: Record<string, unknown>
  ): { done: boolean; chunk: ICompletionResponseChunk } {
    // TODO: Create a stream parser for LLAMA
    const completionReasonMap = {
      FINISH: ChoiceEndReason.COMPLETE,
      LENGTH: ChoiceEndReason.STOP,
      CONTENT_FILTERED: ChoiceEndReason.STOP,
    } as const;

    // streaming:
    if (chunk.outputText) {
      const parsed: TitanChunk = chunk as unknown as TitanChunk;
      // non-streaming:
      return {
        done: true,
        chunk: {
          model,
          choices: [
            {
              chunkText: parsed.outputText,
              index: parsed.index,
              status: ChoiceStatus.END,
              statusEndReason: completionReasonMap[parsed.completionReason] ?? chunk.completionReason,
            },
          ],
        },
      };
    }

    if (chunk.results) {
      // non-streaming:
      return {
        done: true,
        chunk: {
          model,
          choices: (chunk.results as Array<TitanResultElement>).map((result, index) => ({
            chunkText: result.outputText,
            index: index,
            status: ChoiceStatus.END,
            statusEndReason: completionReasonMap[result.completionReason] ?? chunk.completionReason,
          })),
        },
      };
    }

    throw new Error('Bedrock Titan: Unsupported chunk format.');
  }

  pushToolMessages(
    _messages: IMessage[],
    _tool: { name: string; id: string; parameters: string },
    _result: string,
    _thinkingBlocks?: unknown[]
  ): unknown {
    throw new Error('Bedrock Titan: push tool messages not supported.');
  }
}
