import type { IMessage, ModelInfo } from '@bike4mind/common';
import type {
  CompletionInfo,
  IChoiceEndToolUse,
  ICompletionBackend,
  ICompletionOptions,
} from '@bike4mind/llm-adapters';
import { localModelId, parseLocalModelId, serverRuntimeId } from '@bike4mind/local-models/servers';
import { clean } from '../models/localModels.js';

export interface ServerModelBackendOptions {
  server: { id: string; name: string };
  /** Told once per model that is sent without tools because the server lists it without tool support. */
  onNotice?: (text: string) => void;
}

/**
 * One saved model server's backend. Its models get `local:srv-<id>:<name>` ids, so the same model on two
 * servers is two entries, and are named "<model> on <server>"; the server itself is sent the bare name.
 */
export class ServerModelBackend implements ICompletionBackend {
  public currentModel = '';
  private readonly runtimeId: string;
  private readonly toolless = new Set<string>();
  private readonly noticed = new Set<string>();

  constructor(
    private readonly inner: ICompletionBackend,
    private readonly options: ServerModelBackendOptions
  ) {
    this.runtimeId = serverRuntimeId(options.server.id);
  }

  idFor(name: string): string {
    return localModelId(this.runtimeId, name);
  }

  /** The server's own name for a CLI model id, or null when the id is not on this server. */
  nameOf(id: string): string | null {
    const parsed = parseLocalModelId(id);
    return parsed?.runtimeId === this.runtimeId ? parsed.model : null;
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    const models = await this.inner.getModelInfo();
    const server = clean(this.options.server.name);
    this.toolless.clear();
    for (const model of models) if (model.supportsTools === false) this.toolless.add(model.id);
    return models.map(
      model => ({ ...model, id: this.idFor(model.id), name: `${model.name} on ${server}` }) as ModelInfo
    );
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    this.currentModel = model;
    const name = this.nameOf(model) ?? model;
    const withTools = Array.isArray(options.tools) ? options.tools.length > 0 : Boolean(options.tools);
    if (!withTools || !this.toolless.has(name)) return this.inner.complete(name, messages, options, callback);
    if (!this.noticed.has(name)) {
      this.noticed.add(name);
      this.options.onNotice?.(
        `${clean(name)} on ${clean(this.options.server.name)} has no tool support, so the CLI chats with it without tools. Pick a model with tool support to use tools.`
      );
    }
    return this.inner.complete(name, messages, { ...options, tools: undefined }, callback);
  }

  pushToolMessages(
    messages: IMessage[],
    tool: IChoiceEndToolUse['tool'],
    result: string,
    thinkingBlocks?: unknown[]
  ): void {
    this.inner.pushToolMessages(messages, tool, result, thinkingBlocks);
  }
}
