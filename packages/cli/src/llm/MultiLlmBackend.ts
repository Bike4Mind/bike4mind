import type { IMessage, ModelInfo } from '@bike4mind/common';
import type {
  ICompletionBackend,
  ICompletionOptions,
  CompletionInfo,
  IChoiceEndToolUse,
} from '@bike4mind/llm-adapters';

type ServerBackend = ICompletionBackend; // ServerLlmBackend | WebSocketLlmBackend

/** A local backend (Ollama, or one saved model server) and the models it serves. */
export interface LlmRoute {
  backend: ICompletionBackend;
  models: ModelInfo[];
}

/**
 * Routes completions between the B4M server and local backends by model id. A model no local
 * backend lists goes to the B4M server; on an id clash the earlier route wins.
 */
export class MultiLlmBackend implements ICompletionBackend {
  public currentModel: string;
  private readonly byModel = new Map<string, ICompletionBackend>();

  constructor(
    private serverBackend: ServerBackend,
    private serverModels: ModelInfo[],
    private routes: LlmRoute[],
    initialModel: string
  ) {
    this.currentModel = initialModel;
    for (const route of routes) {
      for (const model of route.models) if (!this.byModel.has(model.id)) this.byModel.set(model.id, route.backend);
    }
  }

  private backendFor(model: string): ICompletionBackend {
    return this.byModel.get(model) ?? this.serverBackend;
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    return this.backendFor(model).complete(model, messages, options, callback);
  }

  pushToolMessages(
    messages: IMessage[],
    tool: IChoiceEndToolUse['tool'],
    result: string,
    thinkingBlocks?: unknown[]
  ): void {
    this.backendFor(this.currentModel).pushToolMessages(messages, tool, result, thinkingBlocks);
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [...this.serverModels, ...this.routes.flatMap(route => route.models)];
  }
}
