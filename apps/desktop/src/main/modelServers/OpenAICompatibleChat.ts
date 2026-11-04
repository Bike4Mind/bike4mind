import { createParser } from 'eventsource-parser';
import {
  OpenAICompatibleRuntime,
  type FetchLike,
  type InstalledModel,
  type OpenAICompatibleProduct,
} from '@bike4mind/local-models';
import {
  contextTooSmallHint as sharedContextTooSmallHint,
  holdsPrompt,
  refusesTools,
  probeToolSupport,
  serverContextTokens,
  toolsOffHint as sharedToolsOffHint,
  type HintApp,
} from '@bike4mind/local-models/servers';
import { localBackend, localModelId, parseLocalModelId, type ChatModelOption, type ChatTokenRate } from '@shared/chat';
import { isChatCapable } from '@shared/models';
import type { CompletionMessage, CompletionRequest } from '../chat/completions';
import type { LocalChat } from '../chat/localChat';
import { estimateTokens, LOCAL_CONTEXT_TARGET_TOKENS, replyLimit, toolReplyReserve } from '../chat/localContext';
import { toMessages } from '../chat/OllamaLocal';
import { OPENAI_COMPATIBLE_EFFORT_LEVELS, openAICompatibleControls } from '../chat/modelControls';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import { estimatedRate, llamaServerRate, type StreamTiming } from '../chat/tokenRate';
import { ServerCredentialsError, ServerForbiddenError } from './errors';
import type { LearnedThinker } from './ModelServerStore';

export interface OpenAICompatibleServer {
  runtimeId: string;
  baseUrl: string;
  label: string;
  product: OpenAICompatibleProduct | null;
  fetch: FetchLike;
  hasCredentials(): boolean;
  /** Removes the server's credential from text it sent, such as an error inside a streamed reply. */
  redact: (text: string, response: Response) => string;
  /** Tools went off or came back on, or a model first replied with reasoning, so the model list changed. */
  toolsChanged?: () => void;
  /** The models that replied with reasoning on an earlier run; see ModelServerStore.thinkers. */
  learnedThinkers?: {
    read(): Promise<readonly LearnedThinker[]>;
    add(model: string, identity: string | undefined): Promise<void>;
    forget(model: string): Promise<void>;
  };
}

const DESKTOP_HINTS: HintApp = {
  name: 'Desktop',
  recheck: 'and Desktop turns them back on at its next check, within a minute.',
};

/** Why tools are off and how to turn them on, for the server's settings row and the chat it happened in. */
export function toolsOffHint(label: string, product: OpenAICompatibleProduct | null): string {
  return sharedToolsOffHint(label, product, DESKTOP_HINTS);
}

/** Why one turn ran without tools when its message, not Desktop's prompt and tools, overflowed the context. */
export function longMessageNotice(model: string, context: number): string {
  return `This message is too long for ${model}'s ${context}-token context to also carry Desktop's tools, so this reply runs without them. A shorter message, or a larger context, keeps them.`;
}

/** Why tools are off when the server's context is too small for Desktop's prompt and tools. */
export function contextTooSmallHint(
  label: string,
  product: OpenAICompatibleProduct | null,
  small: readonly { name: string; context: number }[],
  toolPromptTokens: number
): string {
  return sharedContextTooSmallHint(label, product, small, toolPromptTokens, DESKTOP_HINTS);
}

type Block = {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  source?: { data?: unknown; media_type?: unknown };
};

type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | OpenAIPart[]; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type OpenAIPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OpenAIToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => (block && typeof block === 'object' ? blockText((block as Block).text) : '')).join('');
}

/** Anthropic-style blocks (what ChatService builds) to OpenAI chat messages. */
export function toOpenAIMessages(messages: readonly CompletionMessage[]): OpenAIMessage[] {
  let synthetic = 0;
  return messages.flatMap((message): OpenAIMessage[] => {
    if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
    const blocks = message.content.filter((block): block is Block => !!block && typeof block === 'object');
    const results: OpenAIMessage[] = blocks.flatMap(block =>
      block.type === 'tool_result' && typeof block.tool_use_id === 'string'
        ? [{ role: 'tool' as const, tool_call_id: block.tool_use_id, content: blockText(block.content) }]
        : []
    );
    const text = blocks.map(block => (block.type === 'text' ? blockText(block.text) : '')).join('');
    const toolCalls: OpenAIToolCall[] = blocks.flatMap(block =>
      block.type === 'tool_use' && typeof block.name === 'string'
        ? [
            {
              id: typeof block.id === 'string' ? block.id : `call_${++synthetic}`,
              type: 'function' as const,
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            },
          ]
        : []
    );
    const images: OpenAIPart[] = blocks.flatMap(block =>
      block.type === 'image' && typeof block.source?.data === 'string'
        ? [
            {
              type: 'image_url' as const,
              image_url: {
                url: `data:${typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png'};base64,${block.source.data}`,
              },
            },
          ]
        : []
    );
    const own: OpenAIMessage[] =
      text || toolCalls.length > 0 || images.length > 0
        ? [
            {
              role: message.role,
              content: images.length > 0 ? [...(text ? [{ type: 'text' as const, text }] : []), ...images] : text,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          ]
        : [];
    return [...results, ...own];
  });
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[];
    };
    finish_reason?: unknown;
  }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
  /** llama-server only. */
  timings?: unknown;
  error?: { message?: unknown } | unknown;
}

const STOP_REASONS: Record<string, string> = { length: 'max_tokens', tool_calls: 'tool_use', stop: 'stop' };

/** vLLM's refusal of a prompt plus max_tokens past max_model_len. */
async function overflowsContext(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  return /maximum context length/i.test(await response.clone().text());
}

/**
 * gpt-oss is the template family these servers pass `reasoning_effort` to; nothing else names its
 * levels. A served name can hide it, so its base model and the names sharing its weights count too.
 */
function takesReasoningEffort(model: { name: string; baseModel?: string; aliases?: readonly string[] }): boolean {
  return [model.name, model.baseModel, ...(model.aliases ?? [])].some(name => name && /gpt-oss/i.test(name));
}

/**
 * What the listing says about the weights behind a name (llama-server's file size, LM Studio's
 * arch and quantization), so a learned thinker is forgotten when other weights take its name.
 * Undefined when the listing says nothing, as vLLM's does not.
 */
export function modelIdentity(model: InstalledModel): string | undefined {
  const parts = [model.sizeBytes, model.family, model.parameterSize, model.quantization];
  return parts.some(part => part !== null) ? JSON.stringify(parts) : undefined;
}

/**
 * A conversation's sampling overrides as the product's body fields. vLLM spells the repeat penalty
 * `repetition_penalty`; an unknown product gets only the OpenAI fields.
 */
function samplingFields(
  product: OpenAICompatibleProduct | null,
  generation: CompletionRequest['generation']
): Record<string, number> {
  if (!generation) return {};
  const fields: Record<string, number> = {};
  if (generation.temperature !== undefined) fields.temperature = generation.temperature;
  if (generation.topP !== undefined) fields.top_p = generation.topP;
  if (generation.presencePenalty !== undefined) fields.presence_penalty = generation.presencePenalty;
  if (product === null) return fields;
  if (generation.topK !== undefined) fields.top_k = generation.topK;
  if (generation.repeatPenalty !== undefined)
    fields[product === 'vllm' ? 'repetition_penalty' : 'repeat_penalty'] = generation.repeatPenalty;
  if (generation.minP !== undefined && product !== 'lmstudio') fields.min_p = generation.minP;
  return fields;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Chat with an OpenAI-compatible server (llama-server, LM Studio, vLLM) over `/v1/chat/completions`. */
export class OpenAICompatibleChat implements LocalChat {
  private readonly runtime: OpenAICompatibleRuntime;
  private readonly contexts = new Map<string, number>();
  /**
   * Models whose requests declaring tools were refused, so their chats go without tools until a recheck sees
   * tools accepted again. Tool flags are server-wide on vLLM and llama-server, so one refusal turns tools off
   * for every model there; elsewhere (a proxy fronting several backends) it is per model.
   */
  private readonly refused = new Set<string>();
  /** Whether a vLLM server has been asked once if it takes tools, before any chat found out. */
  private toolsAsked = false;
  private probing: Promise<void> | null = null;
  /** Conversations already told that tools are off. */
  private readonly told = new Set<string>();
  /**
   * Desktop's prompt plus tools, from the last turn that measured them and found the context too small; cleared
   * by a turn whose prompt and tools fit. Feeds the server's hint only: whether a turn sends tools is decided per
   * turn by toolPromptOverflow, since the prompt depends on the conversation's project context and grants.
   */
  private toolPrompt: number | undefined;
  /** Models a listing gave no context for, so a turn does not list the server again to look. */
  private readonly unlistedContexts = new Set<string>();
  /** Names from the last listing, for the server's hint. */
  private listed: string[] = [];
  /**
   * Models a reply came back from with reasoning split out, which is what earns them a thinking
   * switch, each with the identity of its weights then.
   */
  private readonly thinkers = new Map<string, string | undefined>();
  /** Each name's weights in the last listing, where it gives one; see modelIdentity. */
  private readonly identities = new Map<string, string>();
  private recalled: Promise<void> | null = null;
  /** Served names, aliases included, of the gpt-oss models in the last listing. */
  private readonly effortModels = new Set<string>();

  constructor(private readonly server: OpenAICompatibleServer) {
    this.runtime = new OpenAICompatibleRuntime({
      baseUrl: server.baseUrl,
      id: server.runtimeId,
      fetch: server.fetch,
      product: server.product,
      requestTimeoutMs: 8_000,
    });
  }

  /** Rejects when the server cannot be listed, so the caller can mark it down. */
  async listModels(): Promise<ChatModelOption[]> {
    const [models] = await Promise.all([this.runtime.list(), this.recallThinkers()]);
    const before = this.smallKey();
    this.learnContexts(models);
    const chat = models.filter(model => isChatCapable(model.capabilities, 'openai-compatible'));
    this.listed = chat.map(model => model.name);
    this.smallChanged(before);
    this.learnIdentities(models);
    this.effortModels.clear();
    return chat.map(model => {
      const thinks = this.thinkers.has(model.name);
      const effortLevels = takesReasoningEffort(model);
      if (effortLevels) for (const name of [model.name, ...(model.aliases ?? [])]) this.effortModels.add(name);
      const controls = openAICompatibleControls(this.server.product, {
        ...(this.contexts.has(model.name) ? { contextWindow: this.contexts.get(model.name) } : {}),
        effortLevels,
        thinks,
      });
      return {
        id: localModelId(this.server.runtimeId, model.name),
        name: model.name,
        backend: localBackend(this.server.runtimeId),
        ...(model.capabilities.vision ? { supportsVision: true } : {}),
        ...(this.contexts.has(model.name) ? { contextWindow: this.contexts.get(model.name), contextFixed: true } : {}),
        ...(model.baseModel ? { baseModel: model.baseModel } : {}),
        ...(model.aliases?.length
          ? { aliasIds: model.aliases.map(alias => localModelId(this.server.runtimeId, alias)) }
          : {}),
        ...(this.toolsOffFor(model.name) ? { supportsTools: false } : {}),
        // The server does not say which models think, so a model earns the switch by thinking once.
        ...(thinks && !controls.effort ? { thinkingToggle: true, minimalThinks: true as const } : {}),
        supportsReasoningEffort: controls.effort !== undefined,
        controls,
      };
    });
  }

  async contextTokens(modelId: string, signal?: AbortSignal): Promise<number> {
    const name = this.modelName(modelId);
    const known = this.contexts.get(name);
    if (known !== undefined) return known;
    if (this.server.product === 'llama-server') {
      const measured = await serverContextTokens(this.server.fetch, this.server.baseUrl, this.server.product, signal);
      if (measured !== undefined) this.contexts.set(name, measured);
    } else if (this.server.product !== 'lmstudio' && !this.unlistedContexts.has(name)) {
      const models = await this.runtime.list().catch(() => null);
      if (models) {
        this.learnContexts(models);
        if (!this.contexts.has(name)) this.unlistedContexts.add(name);
      }
    }
    return this.contexts.get(name) ?? LOCAL_CONTEXT_TARGET_TOKENS;
  }

  /** Why chats on this server run without tools; null while they have them. */
  toolsHint(): string | null {
    if (this.refused.size > 0) return toolsOffHint(this.server.label, this.server.product);
    return this.contextHint(this.listed);
  }

  /**
   * Asks the server whether it takes tools now, with a one-token request that declares one. Only asks while
   * tools are off, which costs a refusal that never reaches the model, and once on a vLLM server that has
   * not been asked, which starts without tool calling unless told to. Probes a refused model when there is one,
   * so a server that refuses tools for one model is not answered by another that takes them.
   */
  recheckTools(model: string | undefined): Promise<void> {
    if (this.probing) return this.probing;
    const target = this.refused.values().next().value ?? model;
    if (!target) return Promise.resolve();
    if (this.refused.size === 0 && (this.server.product !== 'vllm' || this.toolsAsked)) return Promise.resolve();
    this.probing = probeToolSupport(this.server.fetch, this.server.baseUrl, target)
      .then(verdict => {
        if (verdict === null) return;
        this.toolsAsked = true;
        this.setRefused(target, verdict === 'refused');
      })
      .finally(() => (this.probing = null));
    return this.probing;
  }

  async growFor(): Promise<number | undefined> {
    return undefined;
  }

  async stream(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal?: AbortSignal,
    _onTrimmed?: (dropped: number) => void,
    onNotice?: (message: string) => void
  ): Promise<void> {
    const model = this.modelName(request.model);
    const tools = this.toolsOffFor(model)
      ? []
      : (request.tools ?? []).map(tool => ({ type: 'function', function: tool.toolSchema }));
    const context = this.contexts.get(model);
    const limit = replyLimit(context, request.maxTokens, estimateTokens(toMessages(request.messages), tools));
    const post = (withTools: boolean, maxTokens: number | undefined) =>
      this.server.fetch(`${this.server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages: toOpenAIMessages(request.messages),
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...samplingFields(this.server.product, request.generation),
          ...this.thinkingFields(model, request),
          ...(withTools && tools.length > 0 ? { tools } : {}),
        }),
      });
    const measured = request.toolPromptTokens;
    // Desktop's prompt and tools fit, so the overflow came from this message: a notice for this turn, not the server.
    const longMessage =
      measured !== undefined &&
      context !== undefined &&
      holdsPrompt(context, measured, toolReplyReserve(request.maxTokens));
    if (measured !== undefined || (request.tools?.length ?? 0) > 0) {
      this.learnToolPrompt(measured !== undefined && !longMessage ? measured : undefined);
    }
    let withTools = true;
    let response = await post(withTools, limit);
    if (!response.ok && tools.length > 0 && (await refusesTools(response))) {
      this.setRefused(model, true);
      withTools = false;
      response = await post(withTools, limit);
    }
    // The estimate can run short of the server's own count; without max_tokens it answers in what is left.
    if (!response.ok && limit !== undefined && context !== undefined && (await overflowsContext(response))) {
      response = await post(withTools, undefined);
    }
    const why = this.toolsOffFor(model)
      ? toolsOffHint(this.server.label, this.server.product)
      : measured === undefined || context === undefined
        ? null
        : longMessage
          ? longMessageNotice(model, context)
          : contextTooSmallHint(this.server.label, this.server.product, [{ name: model, context }], measured);
    if (why && onNotice && longMessage) {
      onNotice(why);
    } else if (why && onNotice && request.sessionId && !this.told.has(request.sessionId)) {
      this.told.add(request.sessionId);
      onNotice(why);
    }
    if (!response.ok || !response.body) throw await this.httpError(response);
    await this.readStream(
      response.body,
      onEvent,
      text => this.server.redact(text, response),
      () => this.learnThinking(model)
    );
  }

  /**
   * gpt-oss templates take a `reasoning_effort` level and cannot stop reasoning; other templates
   * that think take Off as `chat_template_kwargs.enable_thinking`. Thinking left on sends nothing.
   */
  private thinkingFields(model: string, request: CompletionRequest): Record<string, unknown> {
    if (this.effortModels.has(model) || takesReasoningEffort({ name: model })) {
      const level = request.reasoningEffort;
      if (!level || !OPENAI_COMPATIBLE_EFFORT_LEVELS.includes(level)) return {};
      // llama-server builds before mid-2026 read the level only from the template kwargs.
      return this.server.product === 'llama-server'
        ? { reasoning_effort: level, chat_template_kwargs: { reasoning_effort: level } }
        : { reasoning_effort: level };
    }
    return request.thinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {};
  }

  private recallThinkers(): Promise<void> {
    this.recalled ??= (this.server.learnedThinkers?.read() ?? Promise.resolve([])).then(
      entries => entries.forEach(entry => this.thinkers.set(entry.model, entry.identity)),
      () => undefined
    );
    return this.recalled;
  }

  /**
   * Forgets a learned thinker whose name now serves other weights, which may not think, and gives one
   * stored without an identity the weights listed now.
   */
  private learnIdentities(models: readonly InstalledModel[]): void {
    this.identities.clear();
    for (const model of models) {
      const identity = modelIdentity(model);
      if (identity) for (const name of [model.name, ...(model.aliases ?? [])]) this.identities.set(name, identity);
    }
    for (const [name, identity] of this.thinkers) {
      const listed = this.identities.get(name);
      if (listed === undefined || listed === identity) continue;
      if (identity === undefined) {
        this.thinkers.set(name, listed);
        void this.server.learnedThinkers?.add(name, listed).catch(() => undefined);
      } else {
        this.thinkers.delete(name);
        void this.server.learnedThinkers?.forget(name).catch(() => undefined);
      }
    }
  }

  private learnThinking(model: string): void {
    if (this.thinkers.has(model)) return;
    const identity = this.identities.get(model);
    this.thinkers.set(model, identity);
    void this.server.learnedThinkers?.add(model, identity).catch(() => undefined);
    this.server.toolsChanged?.();
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: CompletionStreamEvent) => void,
    redact: (text: string) => string,
    onReasoning: () => void
  ) {
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();
    let stopReason: string | undefined;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let reported: ChatTokenRate | undefined;
    // Stamped per network read, so deltas buffered into one read count as one arrival.
    let readAt = 0;
    const timing: StreamTiming = { reads: 0 };
    const streamed = () => {
      if (timing.lastAt !== readAt) timing.reads++;
      if (timing.firstAt === undefined || timing.firstAt === readAt) {
        timing.firstReadDeltas = (timing.firstReadDeltas ?? 0) + 1;
      }
      timing.lastAt = readAt;
      timing.firstAt ??= readAt;
    };
    let done = false;
    let failure: Error | undefined;
    const parser = createParser({
      onEvent: message => {
        if (message.data === '[DONE]') {
          done = true;
          return;
        }
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(message.data) as StreamChunk;
        } catch {
          failure = new Error(`${this.server.label} sent a malformed stream frame.`);
          return;
        }
        if (chunk.error) {
          const detail = (chunk.error as { message?: unknown }).message;
          failure = new Error(
            `${this.server.label}: ${typeof detail === 'string' ? redact(detail) : 'the reply failed.'}`
          );
          return;
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          streamed();
          onReasoning();
          onEvent({ type: 'content', text: `<think>${reasoning}</think>` });
        }
        if (typeof delta?.content === 'string' && delta.content) {
          streamed();
          onEvent({ type: 'content', text: delta.content });
        }
        for (const call of delta?.tool_calls ?? []) {
          streamed();
          const index = typeof call.index === 'number' ? call.index : calls.size;
          const entry = calls.get(index) ?? { name: '', arguments: '' };
          if (typeof call.id === 'string') entry.id = call.id;
          if (typeof call.function?.name === 'string') entry.name += call.function.name;
          if (typeof call.function?.arguments === 'string') entry.arguments += call.function.arguments;
          calls.set(index, entry);
        }
        if (typeof choice?.finish_reason === 'string')
          stopReason = STOP_REASONS[choice.finish_reason] ?? choice.finish_reason;
        if (chunk.usage) {
          const inputTokens = tokenCount(chunk.usage.prompt_tokens);
          const outputTokens = tokenCount(chunk.usage.completion_tokens);
          usage = {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          };
        }
        reported = llamaServerRate(chunk.timings) ?? reported;
      },
    });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!failure) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        readAt = performance.now();
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (failure) throw failure;
    if (!done && stopReason === undefined) throw new Error(`${this.server.label} ended the reply before it finished.`);
    const tools = [...calls.values()]
      .filter(call => call.name)
      .map(call => ({ name: call.name, arguments: call.arguments || '{}', ...(call.id ? { id: call.id } : {}) }));
    if (tools.length > 0) onEvent({ type: 'tool_use', tools });
    const rate = reported ?? estimatedRate(usage?.outputTokens, timing);
    onEvent({
      type: 'content',
      stopReason: stopReason ?? 'stop',
      ...(usage ? { usage } : {}),
      ...(rate ? { rate } : {}),
    });
  }

  private learnContexts(models: readonly InstalledModel[]): void {
    for (const model of models) {
      if (model.contextLength === undefined) continue;
      for (const name of [model.name, ...(model.aliases ?? [])]) this.contexts.set(name, model.contextLength);
    }
  }

  private serverWideTools(): boolean {
    return this.server.product === 'vllm' || this.server.product === 'llama-server';
  }

  private toolsOffFor(name: string): boolean {
    return this.serverWideTools() ? this.refused.size > 0 : this.refused.has(name);
  }

  private setRefused(name: string, refused: boolean): void {
    const before = this.refused.size;
    if (refused) this.refused.add(name);
    else if (this.serverWideTools()) this.refused.clear();
    else this.refused.delete(name);
    if (this.refused.size === before) return;
    if (this.refused.size === 0) this.told.clear();
    this.server.toolsChanged?.();
  }

  private learnToolPrompt(tokens: number | undefined): void {
    if (tokens === this.toolPrompt) return;
    const before = this.smallKey();
    this.toolPrompt = tokens;
    this.smallChanged(before);
  }

  /** Whether the server's context for `name` cannot hold Desktop's prompt and tools, as last measured. */
  private tooSmall(name: string): boolean {
    const context = this.contexts.get(name);
    return this.toolPrompt !== undefined && context !== undefined && !holdsPrompt(context, this.toolPrompt);
  }

  private smallKey(): string {
    return this.listed.filter(name => this.tooSmall(name)).join('\n');
  }

  /** A model's context crossed the line either way, so its tools and the server's hint change. */
  private smallChanged(before: string): void {
    const after = this.smallKey();
    if (after === before) return;
    if (!after) this.told.clear();
    this.server.toolsChanged?.();
  }

  private contextHint(names: readonly string[]): string | null {
    const measured = this.toolPrompt;
    if (measured === undefined) return null;
    const small = names.flatMap(name => (this.tooSmall(name) ? [{ name, context: this.contexts.get(name)! }] : []));
    return small.length > 0 ? contextTooSmallHint(this.server.label, this.server.product, small, measured) : null;
  }

  private modelName(modelId: string): string {
    const parsed = parseLocalModelId(modelId);
    if (parsed?.runtimeId !== this.server.runtimeId) throw new Error('Invalid local model id.');
    return parsed.model;
  }

  private async httpError(response: Response): Promise<Error> {
    if (response.status === 401) return new ServerCredentialsError(this.server.label, this.server.hasCredentials());
    if (response.status === 403) return new ServerForbiddenError(this.server.label);
    const body: unknown = await response.json().catch(() => null);
    const error = body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : null;
    const detail =
      typeof error === 'string'
        ? error
        : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : '';
    return new Error(`${this.server.label} returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
  }
}
