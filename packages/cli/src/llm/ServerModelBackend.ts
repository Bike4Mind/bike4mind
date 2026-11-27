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
  /** Scrubs the server's credential from errors, such as an error frame inside a 200 stream that echoes it. */
  redact?: (text: string) => string;
}

/** Set by OllamaBackend when /api/show failed, so a model's missing tool support was never confirmed. */
type ToolSupportChecker = { toolSupportUnchecked?: (model: string) => boolean };

/**
 * One saved model server's backend. Its models get `local:srv-<id>:<name>` ids, so the same model on two
 * servers is two entries, and are named "<model> on <server>"; the server itself is sent the bare name.
 */
export class ServerModelBackend implements ICompletionBackend {
  private readonly runtimeId: string;
  private readonly toolless = new Set<string>();
  private readonly unchecked = new Set<string>();
  private readonly noticed = new Set<string>();

  constructor(
    private readonly inner: ICompletionBackend,
    private readonly options: ServerModelBackendOptions
  ) {
    this.runtimeId = serverRuntimeId(options.server.id);
  }

  get currentModel(): string {
    return this.inner.currentModel;
  }

  set currentModel(model: string) {
    this.inner.currentModel = model;
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
    const models = await this.inner.getModelInfo().catch(error => {
      throw this.scrub(error);
    });
    const server = clean(this.options.server.name);
    const checker = this.inner as ToolSupportChecker;
    this.toolless.clear();
    this.unchecked.clear();
    for (const model of models) {
      if (model.supportsTools !== false) continue;
      this.toolless.add(model.id);
      if (checker.toolSupportUnchecked?.(model.id)) this.unchecked.add(model.id);
    }
    return models.map(
      model =>
        ({
          ...model,
          id: this.idFor(model.id),
          name: `${model.name} on ${server}`,
          description: `Served by ${server}, a model server saved in Desktop. Capabilities depend on the model.`,
        }) as ModelInfo
    );
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    const name = this.nameOf(model) ?? model;
    const withTools = Array.isArray(options.tools) ? options.tools.length > 0 : Boolean(options.tools);
    const sendTools = withTools && !this.toolless.has(name);
    if (withTools && !sendTools && !this.noticed.has(name)) {
      this.noticed.add(name);
      const where = `${clean(name)} on ${clean(this.options.server.name)}`;
      this.options.onNotice?.(
        this.unchecked.has(name)
          ? `The CLI could not check whether ${where} supports tools, so it chats with it without tools. Start a new b4m session to check again.`
          : `${where} has no tool support, so the CLI chats with it without tools. Pick a model with tool support to use tools.`
      );
    }
    try {
      await this.inner.complete(name, messages, sendTools ? options : { ...options, tools: undefined }, callback);
    } catch (error) {
      throw this.scrub(error);
    }
  }

  pushToolMessages(
    messages: IMessage[],
    tool: IChoiceEndToolUse['tool'],
    result: string,
    thinkingBlocks?: unknown[]
  ): void {
    this.inner.pushToolMessages(messages, tool, result, thinkingBlocks);
  }

  /** A copy of the error with the credential scrubbed from its message and stack; the cause is dropped. */
  private scrub(error: unknown): unknown {
    const redact = this.options.redact;
    if (!redact || !(error instanceof Error)) return error;
    const message = redact(error.message);
    const stack = error.stack === undefined ? undefined : redact(error.stack);
    if (message === error.message && stack === error.stack) return error;
    const copy = new Error(message);
    copy.name = error.name;
    copy.stack = stack;
    return copy;
  }
}
