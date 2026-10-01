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
import type { ModelInfo } from '@bike4mind/common';

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
  // Deliberately does NOT opt into signalsStreamTermination: complete() below forces
  // stream:false, and the truncation guard lives on the streaming branch, so the override
  // would be unreachable. Re-add it only if this adapter ever streams.

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
    // AWS end-of-lifed ai21.j2-ultra-v1 and ai21.j2-mid-v1 on Bedrock; invoking them now fails with
    // "The provided model identifier is invalid". Returning no models drops them from
    // getAvailableModels() and so from every picker, the same way titan.ts retires its EOL models.
    // The ChatModels enum members stay so persisted records that reference these ids still validate.
    return [];
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
