import AnthropicBedrockBackend from './anthropic';
import JurassicTwoBedrockBackend from './jurassicTwo';
import LlamaBedrockBackend from './llama';
import TitanBedrockBackend from './titan';
import type { IChoiceEndToolUse, ICompletionOptions, ICompletionResponseChunk } from '../backend';
import { BaseBedrockBackend } from './base';
import { IMessage, ModelInfo } from '@bike4mind/common';
import DeepSeekBedrockBackend from './deepseek';

// Useful for getModelInfo():
export class UndifferentiatedBedrockBackend extends BaseBedrockBackend {
  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      ...(await new AnthropicBedrockBackend().getModelInfo()),
      ...(await new LlamaBedrockBackend().getModelInfo()),
      ...(await new JurassicTwoBedrockBackend().getModelInfo()),
      ...(await new TitanBedrockBackend().getModelInfo()),
      ...(await new DeepSeekBedrockBackend().getModelInfo()),
    ];
  }

  formatMessages(message: IMessage[]): IMessage[] {
    throw new Error('UndifferentiatedBedrockBackend does not support formatMessages');
  }

  getPayload(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>
  ): {
    modelId: string;
    contentType: string;
    accept: string;
    body: string;
  } {
    throw new Error('UndifferentiatedBedrockBackend does not support getPayload');
  }

  translateStreamChunk(model: string, chunk: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    throw new Error('UndifferentiatedBedrockBackend does not support translateStreamChunk');
  }

  translateChunk(model: string, chunk: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    throw new Error('UndifferentiatedBedrockBackend does not support translateChunk');
  }

  pushToolMessages(
    messages: IMessage[],
    tool: IChoiceEndToolUse['tool'],
    result: string,
    _thinkingBlocks?: unknown[]
  ): unknown {
    throw new Error('UndifferentiatedBedrockBackend does not support pushToolMessages');
  }
}
