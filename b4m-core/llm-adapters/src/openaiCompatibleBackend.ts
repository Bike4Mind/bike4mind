import {
  ARTIFACT_REMOVED_PLACEHOLDER,
  createThinkMarkerEscaper,
  IMessage,
  ModelBackend,
  PermissionDeniedError,
  stripToolArtifactMarkup,
  type ModelInfo,
} from '@bike4mind/common';
import {
  contextTooSmallHint,
  describeFailure,
  holdsPrompt,
  isToolRefusal,
  OpenAICompatibleRuntime,
  redactServerResponse,
  serverContextTokens,
  toolsOffHint,
  type FetchLike,
  type HintApp,
  type OpenAICompatibleProduct,
} from '@bike4mind/local-models/servers';
import { ILogger, Logger } from '@bike4mind/observability';
import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources';
import {
  CompletionInfo,
  DEFAULT_MAX_TOOL_CALLS,
  IChoiceEndToolUse,
  ICompletionBackend,
  ICompletionOptionTools,
  ICompletionOptions,
} from './backend';
import { appendCacheInclusiveTurn, splitCacheInclusiveInput } from './cacheInclusiveUsage';
import { executeToolsBatch, shouldEndTurnAfterTools } from './executeToolsBatch';
import {
  appendIdentityReminderToMessages,
  buildIdentityReminder,
  shouldOmitIdentityReminder,
} from './identityReminder';
import { OutputBudgetExhaustedError, StreamEndedWithoutFinishError } from './llmEmptyTurnErrors';
import { convertMessagesToOpenAIFormat } from './messageFormatConverter';
import { recordToolResult, type RecordableToolUse } from './recordToolResult';
import { normalizeOpenAIFinishReason } from './stopReason';
import { stripToolDependentMessages } from './toolPairingUtils';
import {
  declaredArtifactType,
  createRecursiveArtifactGuard,
  handleToolResultStreaming,
  stripUnstreamedToolResult,
} from './toolStreamingHelper';

export interface OpenAICompatibleBackendOptions {
  /** Server root, without `/v1`. */
  baseUrl: string;
  /** Shown in errors and notices. */
  label: string;
  product: OpenAICompatibleProduct | null;
  /** Adds the server's credentials; the backend sends none of its own. */
  fetch: FetchLike;
  logger?: ILogger;
  /** Called once per cause (tools refused, context too small) with a line that says how to fix it. */
  onNotice?: (text: string) => void;
  app?: HintApp;
}

type ToolRoundResult = { tool: IChoiceEndToolUse['tool']; result: string };

const DEFAULT_CONTEXT_WINDOW = 16_384;
const CHARS_PER_TOKEN = 4;
const REQUEST_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_APP: HintApp = { name: 'the CLI', recheck: 'then start a new b4m session.' };

/** vLLM, llama-server, LM Studio and any other server that speaks OpenAI's `/v1/chat/completions`. */
export class OpenAICompatibleBackend implements ICompletionBackend {
  public currentModel = '';
  private readonly api: OpenAI;
  private readonly runtime: OpenAICompatibleRuntime;
  private readonly logger: ILogger;
  private readonly app: HintApp;
  private toolsOff = false;
  private toolsOffNoticed = false;
  private readonly smallNoticed = new Set<string>();
  private readonly canonical = new Map<string, string>();
  private readonly contexts = new Map<string, number>();
  private listed = false;

  constructor(private readonly options: OpenAICompatibleBackendOptions) {
    this.logger = options.logger ?? new Logger();
    this.app = options.app ?? DEFAULT_APP;
    this.runtime = new OpenAICompatibleRuntime({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      product: options.product,
    });
    this.api = new OpenAI({
      apiKey: 'none',
      baseURL: `${this.runtime.baseUrl}/v1`,
      fetch: this.guardedFetch() as unknown as typeof fetch,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  /** Drops the SDK's own `authorization` and scrubs credentials out of error bodies before the SDK reads them. */
  private guardedFetch(): FetchLike {
    return async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      const response = await this.options.fetch(String(input), {
        ...init,
        headers: Object.fromEntries(headers.entries()),
      });
      if (response.ok) return response;
      const text = redactServerResponse(await response.text(), response);
      return new Response(text, { status: response.status, statusText: response.statusText });
    };
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    const models = await this.runtime.list();
    this.listed = true;
    return Promise.all(
      models.map(async model => {
        this.canonical.set(model.name, model.name);
        for (const alias of model.aliases ?? []) this.canonical.set(alias, model.name);
        const reported =
          model.contextLength ??
          (await serverContextTokens(this.options.fetch, this.runtime.baseUrl, this.options.product));
        if (reported) this.contexts.set(model.name, reported);
        const contextWindow = reported ?? DEFAULT_CONTEXT_WINDOW;
        return {
          id: model.name,
          type: 'text',
          name: model.baseModel ? `${model.name} (LoRA on ${model.baseModel})` : model.name,
          backend: ModelBackend.OpenAICompatible,
          contextWindow,
          max_tokens: Math.max(1, Math.floor(contextWindow / 2)),
          supportsImageVariation: false,
          pricing: { [contextWindow]: { input: 0, output: 0 } },
          freeToRun: true,
          supportsVision: model.capabilities.vision,
          supportsTools: !this.toolsOff,
          can_think: model.capabilities.thinking,
          can_stream: true,
          description: `Served by ${this.options.label}. Capabilities depend on the model.`,
        } as ModelInfo;
      })
    );
  }

  private async contextOf(name: string): Promise<number | undefined> {
    if (!this.listed) {
      try {
        await this.getModelInfo();
      } catch {
        this.listed = true;
      }
    }
    return this.contexts.get(name);
  }

  private notifyToolsOff() {
    if (this.toolsOffNoticed) return;
    this.toolsOffNoticed = true;
    this.options.onNotice?.(toolsOffHint(this.options.label, this.options.product, this.app));
  }

  /** Whether this turn's tools fit a context the server fixes; unknown contexts are assumed to fit. */
  private async toolsFit(
    name: string,
    messages: IMessage[],
    tools: ICompletionOptionTools[],
    maxTokens: number | undefined
  ): Promise<boolean> {
    const context = await this.contextOf(name);
    if (!context) return true;
    const toolText = JSON.stringify(tools.map(tool => tool.toolSchema));
    const system = messages.filter(message => message.role === 'system').map(textOf);
    const lastUser = messages.findLast(message => message.role === 'user');
    const chars = toolText.length + system.join('').length + (lastUser ? textOf(lastUser).length : 0);
    const promptTokens = Math.ceil(chars / CHARS_PER_TOKEN);
    if (holdsPrompt(context, promptTokens, maxTokens)) return true;
    if (!this.smallNoticed.has(name)) {
      this.smallNoticed.add(name);
      this.options.onNotice?.(
        contextTooSmallHint(this.options.label, this.options.product, [{ name, context }], promptTokens, this.app)
      );
    }
    return false;
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo: CompletionInfo) => Promise<void>,
    toolsUsed: Array<RecordableToolUse> = []
  ): Promise<void> {
    this.currentModel = model;
    const name = this.canonical.get(model) ?? model;
    const toolCallCount = options._internal?.toolCallCount ?? 0;
    const accumInputTokens = options._internal?.accumInputTokens ?? 0;
    const accumOutputTokens = options._internal?.accumOutputTokens ?? 0;
    const accumTurnUsage = options._internal?.accumTurnUsage;
    const maxToolCalls = options._internal?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

    const rawTools = options.tools as unknown;
    const requested: ICompletionOptionTools[] = Array.isArray(rawTools)
      ? (rawTools as ICompletionOptionTools[])
      : rawTools
        ? [rawTools as ICompletionOptionTools]
        : [];

    if (requested.length && toolCallCount >= maxToolCalls) {
      this.logger.warn(`Max tool calls limit (${maxToolCalls}) reached. Disabling tools to prevent infinite loops.`);
      await this.complete(
        model,
        stripToolDependentMessages(messages),
        { ...options, tools: undefined, _internal: options._internal },
        callback,
        toolsUsed
      );
      return;
    }

    let sendTools = requested.length > 0 && !this.toolsOff;
    if (sendTools && !(await this.toolsFit(name, messages, requested, options.maxTokens))) sendTools = false;
    if (requested.length && !sendTools) {
      await this.complete(
        model,
        stripToolDependentMessages(messages),
        { ...options, tools: undefined, _internal: options._internal },
        callback,
        toolsUsed
      );
      return;
    }

    const parameters: ChatCompletionCreateParamsStreaming = {
      model: name,
      messages: this.formatMessages(messages, name, options),
      stream: true,
      stream_options: { include_usage: true },
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options.stop ? { stop: options.stop } : {}),
      ...(sendTools ? { tools: this.formatTools(requested) } : {}),
    };

    let stream;
    try {
      stream = await this.api.chat.completions.create(parameters, { signal: options.abortSignal });
    } catch (error) {
      if (sendTools && error instanceof OpenAI.APIError && error.status !== undefined) {
        const detail = typeof error.error === 'string' ? error.error : JSON.stringify(error.error ?? error.message);
        if (isToolRefusal(error.status, `${error.message} ${detail}`)) {
          this.toolsOff = true;
          this.notifyToolsOff();
          await this.complete(
            model,
            stripToolDependentMessages(messages),
            { ...options, tools: undefined, _internal: options._internal },
            callback,
            toolsUsed
          );
          return;
        }
      }
      throw this.describeError(error);
    }

    const func: { name?: string; id?: string; parameters?: string }[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;
    let inThinking = false;
    const reasoningEscaper = createThinkMarkerEscaper();
    let sawProse = false;
    let roundText = '';
    let reasoning = '';

    const info = (): CompletionInfo => ({
      ...splitCacheInclusiveInput(accumInputTokens + inputTokens, 0),
      outputTokens: accumOutputTokens + outputTokens,
      turnUsage: appendCacheInclusiveTurn(accumTurnUsage, inputTokens, 0, outputTokens),
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
    });

    try {
      for await (const chunk of stream) {
        const out: string[] = [];
        if (chunk.usage) {
          inputTokens = Math.max(inputTokens, chunk.usage.prompt_tokens || 0);
          outputTokens += chunk.usage.completion_tokens || 0;
        }
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta as ChatCompletionChunk.Choice.Delta & {
            reasoning?: string;
            reasoning_content?: string;
          };
          const thinking = delta.reasoning_content || delta.reasoning;
          if (thinking) {
            reasoning += thinking;
            out[choice.index] = (inThinking ? '' : '<think>') + reasoningEscaper.push(thinking);
            inThinking = true;
            if (!delta.content) continue;
          }
          if (inThinking && delta.content) {
            inThinking = false;
            sawProse = true;
            roundText += delta.content;
            out[choice.index] = (out[choice.index] ?? '') + reasoningEscaper.flush() + '</think>' + delta.content;
            continue;
          }
          for (const call of delta.tool_calls ?? []) {
            func[call.index] ||= {};
            func[call.index].name ||= call.function?.name;
            func[call.index].id ||= call.id;
            func[call.index].parameters = (func[call.index].parameters ?? '') + (call.function?.arguments || '');
          }
          if (func.length > 0) continue;
          if (delta.content) sawProse = true;
          roundText += delta.content || '';
          out[choice.index] = delta.content || '';
        }
        await callback(out, {
          ...info(),
          ...(normalizeOpenAIFinishReason(finishReason)
            ? { stopReason: normalizeOpenAIFinishReason(finishReason) }
            : {}),
        });
      }
    } catch (error) {
      throw this.describeError(error);
    }

    if (inThinking) {
      await callback([reasoningEscaper.flush() + '</think>'], info());
      inThinking = false;
    }

    const calls = func.filter(call => call?.name);
    if (!sawProse && calls.length === 0) {
      if (finishReason === 'length') throw new OutputBudgetExhaustedError(this.options.label, name);
      if (finishReason === undefined && !options.abortSignal?.aborted) {
        throw new StreamEndedWithoutFinishError(this.options.label, name);
      }
      throw new Error(
        `${this.options.label} returned no content for ${name} (finish_reason: ${finishReason ?? 'unknown'}).`
      );
    }
    if (calls.length === 0) return;

    for (const call of calls) toolsUsed.push({ name: call.name!, arguments: call.parameters || '{}', id: call.id });

    if (options.executeTools === false) {
      await callback([null], { ...info(), ...(reasoning ? { thinking: [reasoning] } : {}) });
      return;
    }

    type Resolved = {
      id: string;
      name: string;
      parameters: string;
      parsed: Record<string, unknown>;
      toolFn: (params: Record<string, unknown>) => Promise<{ toString(): string }>;
    };
    const resolved: Resolved[] = [];
    for (const call of calls) {
      const { id, name: toolName } = call;
      if (!id || !toolName) continue;
      const toolFn = requested.find(tool => tool.toolSchema.name === toolName)?.toolFn;
      if (!toolFn) continue;
      const parameters = call.parameters || '{}';
      try {
        resolved.push({ id, name: toolName, parameters, parsed: JSON.parse(parameters), toolFn });
      } catch {
        this.logger.warn(`JSON parse error for ${toolName} arguments`);
        const entry = toolsUsed.find(tool => tool.name === toolName && tool.id === id);
        if (entry) entry.arguments = '{}';
        recordToolResult(
          toolsUsed,
          { id, name: toolName },
          'Error: Tool arguments were malformed and could not be parsed.',
          false
        );
      }
    }

    const batch = await executeToolsBatch(
      resolved.map(({ id, name: toolName, parameters, parsed, toolFn }) => async () => ({
        id,
        name: toolName,
        parameters,
        result: await toolFn(parsed),
      })),
      { parallel: options.parallelToolExecution !== false, maxConcurrency: options.maxParallelTools }
    );

    const inheritedGuard = options._internal?.artifactGuard;
    let guard = inheritedGuard;
    const round: ToolRoundResult[] = [];
    for (const [i, outcome] of batch.entries()) {
      const target = resolved[i];
      if (outcome.ok) {
        const { id, name: toolName, parameters, result } = outcome.result;
        let emitted = false;
        await handleToolResultStreaming(
          toolName,
          result,
          async (results, artifactInfo) => {
            emitted = true;
            if (!guard) guard = createRecursiveArtifactGuard(callback);
            await guard.emitArtifact(results, { toolsUsed, ...artifactInfo });
          },
          declaredArtifactType(requested, toolName)
        );
        const resultStr = stripUnstreamedToolResult(toolName, result.toString(), emitted);
        recordToolResult(toolsUsed, { id, name: toolName }, resultStr, true);
        round.push({ tool: { id, name: toolName, parameters }, result: resultStr });
      } else {
        if (outcome.error instanceof PermissionDeniedError) throw outcome.error;
        const message = outcome.error instanceof Error ? outcome.error.message : 'Unknown error';
        const observation = stripToolArtifactMarkup(
          `Error processing ${target.name} tool: ${message}`,
          ARTIFACT_REMOVED_PLACEHOLDER
        );
        recordToolResult(toolsUsed, { id: target.id, name: target.name }, observation, false);
        round.push({ tool: { id: target.id, name: target.name, parameters: target.parameters }, result: observation });
      }
    }
    this.pushToolRound(messages, round, reasoning || undefined);

    if (
      shouldEndTurnAfterTools(
        calls.map(call => call.name!),
        requested,
        roundText
      )
    ) {
      await (guard?.callback ?? callback)([], { ...info(), stopReason: 'tool_use' });
      if (!inheritedGuard && guard) await guard.flush();
      return;
    }

    await this.complete(
      model,
      messages,
      {
        ...options,
        _internal: {
          ...options._internal,
          toolCallCount: toolCallCount + 1,
          accumInputTokens: accumInputTokens + inputTokens,
          accumOutputTokens: accumOutputTokens + outputTokens,
          accumTurnUsage: appendCacheInclusiveTurn(accumTurnUsage, inputTokens, 0, outputTokens),
          artifactGuard: guard,
        },
      },
      guard?.callback ?? callback,
      toolsUsed
    );
    if (!inheritedGuard && guard) await guard.flush();
  }

  /** Credentials never reach a message: 401/403 carry no body, and other bodies were scrubbed by `guardedFetch`. */
  private describeError(error: unknown): unknown {
    const { label } = this.options;
    if (error instanceof OpenAI.APIUserAbortError) return error;
    if (error instanceof OpenAI.APIError && error.status !== undefined) {
      if (error.status === 401 || error.status === 403) return new Error(`${label} needs credentials.`);
      const body = typeof error.error === 'object' && error.error ? (error.error as { message?: unknown }) : undefined;
      const detail = typeof body?.message === 'string' ? body.message : error.message;
      return new Error(`${label} returned HTTP ${error.status}: ${detail}`);
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return new Error(`${label} could not be reached: ${describeFailure(error.cause ?? error)}`);
    }
    return error;
  }

  private formatMessages(
    messages: IMessage[],
    model: string,
    options: Partial<ICompletionOptions>
  ): OpenAI.ChatCompletionMessageParam[] {
    return convertMessagesToOpenAIFormat(
      shouldOmitIdentityReminder(options)
        ? messages
        : appendIdentityReminderToMessages(messages, buildIdentityReminder(model, options.modelDisplayName)),
      { preserveReasoningContent: true }
    ) as OpenAI.ChatCompletionMessageParam[];
  }

  formatTools(tools: ICompletionOptionTools[] = []) {
    return tools.map(tool => ({ type: 'function' as const, function: tool.toolSchema }));
  }

  /** `thinkingBlocks` carries the turn's reasoning as a single string entry. */
  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string, thinkingBlocks?: unknown[]) {
    const reasoning = typeof thinkingBlocks?.[0] === 'string' ? thinkingBlocks[0] : undefined;
    this.pushToolRound(messages, [{ tool, result }], reasoning);
  }

  private pushToolRound(messages: IMessage[], round: ToolRoundResult[], reasoning: string | undefined) {
    if (round.length === 0) return;
    messages.push({
      content: null,
      role: 'assistant',
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: round.map(({ tool }) => ({
        id: tool.id,
        type: 'function',
        function: { name: tool.name, arguments: tool.parameters },
      })),
    } as unknown as IMessage);
    for (const { tool, result } of round) {
      messages.push({
        role: 'tool',
        content: JSON.stringify({ result }),
        tool_call_id: tool.id,
        name: tool.name,
      } as unknown as IMessage);
    }
  }
}

function textOf(message: IMessage): string {
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? ''))).join('');
}
