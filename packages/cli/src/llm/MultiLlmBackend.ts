import type { IMessage, ModelInfo } from '@bike4mind/common';
import type {
  ICompletionBackend,
  ICompletionOptions,
  CompletionInfo,
  IChoiceEndToolUse,
} from '@bike4mind/llm-adapters';
import type { OllamaBackend } from '@bike4mind/llm-adapters';

type ServerBackend = ICompletionBackend; // ServerLlmBackend | WebSocketLlmBackend

/**
 * Routes completions between B4M server and a local Ollama instance
 * based on the selected model's backend type.
 */
export class MultiLlmBackend implements ICompletionBackend {
  public currentModel: string;
  private ollamaModelIds: Set<string>;

  constructor(
    private serverBackend: ServerBackend,
    private ollamaBackend: OllamaBackend,
    private serverModels: ModelInfo[],
    private ollamaModels: ModelInfo[],
    initialModel: string
  ) {
    this.currentModel = initialModel;
    this.ollamaModelIds = new Set(ollamaModels.map(m => m.id));
  }

  private get activeBackend(): ICompletionBackend {
    return this.ollamaModelIds.has(this.currentModel) ? this.ollamaBackend : this.serverBackend;
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    const backend = this.ollamaModelIds.has(model) ? this.ollamaBackend : this.serverBackend;
    return backend.complete(model, messages, options, callback);
  }

  pushToolMessages(
    messages: IMessage[],
    tool: IChoiceEndToolUse['tool'],
    result: string,
    thinkingBlocks?: unknown[]
  ): void {
    this.activeBackend.pushToolMessages(messages, tool, result, thinkingBlocks);
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [...this.serverModels, ...this.ollamaModels];
  }
}
