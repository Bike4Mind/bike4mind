import { IMessage } from '@bike4mind/common';
import {
  ChoiceEndReason,
  ChoiceStatus,
  type CompletionInfo,
  IChoiceEnd,
  ICompletionOptions,
  ICompletionResponseChunk,
} from '../backend';
import { BaseBedrockBackend } from './base';
import { ChatModels, ModelBackend, ModelInfo } from '@bike4mind/common';

interface JurassicChunk {
  completions: Array<{
    data: {
      text: string;
    };
    finishReason: {
      reason: 'endoftext';
    };
  }>;
}

export default class JurassicTwoBedrockBackend extends BaseBedrockBackend {
  // Override complete method to force non-streaming since Jurassic-2 doesn't support streaming
  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    // Jurassic-2 models do not support streaming; force non-streaming to avoid runtime errors
    const nonStreamingOptions: Partial<ICompletionOptions> = { ...options, stream: false };
    return super.complete(model, messages, nonStreamingOptions, callback);
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: ChatModels.JURASSIC2_ULTRA,
        type: 'text' as const,
        name: 'Jurassic-2 Ultra',
        backend: ModelBackend.Bedrock,
        contextWindow: 8192,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: false,
        pricing: {
          4000: { input: 0.0188 / 1000, output: 0.0188 / 1000 }, // $0.0188 / 1,000 Input tokens, $0.0188 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },
        supportsVision: false,
        logoFile: 'AI21Labs.png',
        rank: 50,
        description:
          "AI21 Labs' most powerful Jurassic-2 model with strong reasoning capabilities. Good for complex reasoning, creative tasks, and detailed analysis.",
      },
      {
        id: ChatModels.JURASSIC2_MID,
        type: 'text' as const,
        name: 'Jurassic-2 Mid',
        backend: ModelBackend.Bedrock,
        contextWindow: 8192,
        supportsImageVariation: false,
        max_tokens: 8192,
        can_stream: false,
        pricing: {
          4000: { input: 0.0125 / 1000, output: 0.0125 / 1000 }, // $0.0125 / 1,000 Input tokens, $0.0125 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
        },
        supportsVision: false,
        logoFile: 'AI21Labs.png',
        rank: 50,
        description:
          "AI21 Labs' balanced Jurassic-2 model offering good performance at moderate cost. Great for everyday tasks and general content generation.",
      },
    ];
  }

  getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): { modelId: string; contentType: string; accept: string; body: string } {
    const joinedMessages = messages.map(m => `<${m.role}>\n${m.content}\n</${m.role}>`).join('\n');

    return {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        prompt: joinedMessages,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        maxTokens: options.maxTokens,
        stopSequences: options.stop,
        // TODO: Supports some token penalties, similar to OpenAI
      }),
    };
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  translateChunk(model: string, chunk: Record<string, unknown>): { done: boolean; chunk: ICompletionResponseChunk } {
    // TODO: Create a parser for LLAMA
    return this.translateStreamChunk(model, chunk);
  }

  translateStreamChunk(
    model: string,
    chunk: Record<string, unknown>
  ): { done: boolean; chunk: ICompletionResponseChunk } {
    const finishReasonMap = {
      endoftext: ChoiceEndReason.STOP,
    };

    const parsed: JurassicChunk = chunk as unknown as JurassicChunk;
    const done = parsed.completions.every(c => !!c.finishReason?.reason);
    return {
      done,
      chunk: {
        model,
        choices: parsed.completions.map((c, index) => {
          if (done) {
            return {
              chunkText: c.data.text,
              index,
              status: ChoiceStatus.END,
              statusEndReason: done ? finishReasonMap[c.finishReason?.reason] : undefined,
            } as IChoiceEnd;
          }

          return {
            chunkText: c.data.text,
            index,
            status: ChoiceStatus.STREAM,
          };
        }),
      },
    };
  }

  pushToolMessages(
    _messages: IMessage[],
    _tool: { name: string; id: string; parameters: string },
    _result: string,
    _thinkingBlocks?: unknown[]
  ): unknown {
    throw new Error('Bedrock JurassicTwo: pushToolMessages not yet supported.');
  }
}
