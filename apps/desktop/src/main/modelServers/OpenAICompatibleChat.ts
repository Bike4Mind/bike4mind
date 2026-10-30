import { createParser } from 'eventsource-parser';
import {
  OpenAICompatibleRuntime,
  type FetchLike,
  type InstalledModel,
  type OpenAICompatibleProduct,
} from '@bike4mind/local-models';
import { localBackend, localModelId, parseLocalModelId, type ChatModelOption } from '@shared/chat';
import type { CompletionMessage, CompletionRequest } from '../chat/completions';
import type { LocalChat } from '../chat/localChat';
import { LOCAL_CONTEXT_TARGET_TOKENS } from '../chat/localContext';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import { ServerCredentialsError } from './errors';

export interface OpenAICompatibleServer {
  runtimeId: string;
  baseUrl: string;
  label: string;
  product: OpenAICompatibleProduct | null;
  fetch: FetchLike;
  hasCredentials(): boolean;
  /** Removes the server's credential from text it sent, such as an error inside a streamed reply. */
  redact: (text: string, response: Response) => string;
  /** Tools went off or came back on, so the server's view and the model list changed. */
  toolsChanged?: () => void;
}

const PROPS_TIMEOUT_MS = 5_000;
/** Long enough for a busy server to produce the probe's one token. */
const TOOLS_PROBE_TIMEOUT_MS = 20_000;
const PROBE_TOOL = {
  type: 'function',
  function: { name: 'ping', description: 'Replies pong.', parameters: { type: 'object', properties: {} } },
};

/** Why tools are off and how to turn them on, for the server's settings row and the chat it happened in. */
export function toolsOffHint(label: string, product: OpenAICompatibleProduct | null): string {
  const after = 'and Desktop turns them back on at its next check, within a minute.';
  if (product === 'vllm')
    return `${label} was started without tool calling, so its chats run without tools. Restart vLLM with --enable-auto-tool-choice and a --tool-call-parser for the model, ${after}`;
  if (product === 'llama-server')
    return `${label} refuses tool calls, so its chats run without tools. Restart llama-server with --jinja, ${after}`;
  return `${label} refuses tool calls, so its chats run without tools. Turn tool calling on there, ${after}`;
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
  error?: { message?: unknown } | unknown;
}

const STOP_REASONS: Record<string, string> = { length: 'max_tokens', tool_calls: 'tool_use', stop: 'stop' };

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Chat with an OpenAI-compatible server (llama-server, LM Studio, vLLM) over `/v1/chat/completions`. */
export class OpenAICompatibleChat implements LocalChat {
  private readonly runtime: OpenAICompatibleRuntime;
  private readonly contexts = new Map<string, number>();
  /**
   * The server refused a request that declared tools, so chats go without them until a recheck sees tools
   * accepted again. Tool flags are server-wide on vLLM and llama-server, so this is too.
   */
  private toolsOff = false;
  /** Whether a vLLM server has been asked once if it takes tools, before any chat found out. */
  private toolsAsked = false;
  private probing: Promise<void> | null = null;
  /** Conversations already told that tools are off. */
  private readonly told = new Set<string>();

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
    const models = await this.runtime.list();
    this.learnContexts(models);
    return models
      .filter(model => !model.capabilities.embeddings || model.capabilities.completion)
      .map(model => ({
        id: localModelId(this.server.runtimeId, model.name),
        name: model.name,
        backend: localBackend(this.server.runtimeId),
        ...(model.capabilities.vision ? { supportsVision: true } : {}),
        ...(this.contexts.has(model.name) ? { contextWindow: this.contexts.get(model.name) } : {}),
        ...(model.baseModel ? { baseModel: model.baseModel } : {}),
        ...(this.toolsOff ? { supportsTools: false } : {}),
      }));
  }

  async contextTokens(modelId: string, signal?: AbortSignal): Promise<number> {
    const name = this.modelName(modelId);
    const known = this.contexts.get(name);
    if (known !== undefined) return known;
    if (this.server.product === 'llama-server') {
      const measured = await this.llamaServerContext(signal);
      if (measured !== undefined) this.contexts.set(name, measured);
    } else if (this.server.product !== 'lmstudio') {
      this.learnContexts(await this.runtime.list().catch(() => []));
    }
    return this.contexts.get(name) ?? LOCAL_CONTEXT_TARGET_TOKENS;
  }

  /** Why chats on this server run without tools; null while they have them. */
  toolsHint(): string | null {
    return this.toolsOff ? toolsOffHint(this.server.label, this.server.product) : null;
  }

  /**
   * Asks the server whether it takes tools now, with a one-token request that declares one. Only asks while
   * tools are off, which costs a refusal that never reaches the model, and once on a vLLM server that has
   * not been asked, which starts without tool calling unless told to.
   */
  recheckTools(model: string | undefined): Promise<void> {
    if (!model || this.probing) return this.probing ?? Promise.resolve();
    if (!this.toolsOff && (this.server.product !== 'vllm' || this.toolsAsked)) return Promise.resolve();
    this.probing = this.probeTools(model)
      .then(verdict => {
        if (verdict === null) return;
        this.toolsAsked = true;
        this.setToolsOff(verdict === 'refused');
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
    const tools = this.toolsOff
      ? []
      : (request.tools ?? []).map(tool => ({ type: 'function', function: tool.toolSchema }));
    const post = (withTools: boolean) =>
      this.server.fetch(`${this.server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages: toOpenAIMessages(request.messages),
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...(withTools && tools.length > 0 ? { tools } : {}),
        }),
      });
    let response = await post(true);
    if (!response.ok && tools.length > 0 && (await refusedTools(response))) {
      this.setToolsOff(true);
      response = await post(false);
    }
    if (this.toolsOff && onNotice && request.sessionId && !this.told.has(request.sessionId)) {
      this.told.add(request.sessionId);
      onNotice(toolsOffHint(this.server.label, this.server.product));
    }
    if (!response.ok || !response.body) throw await this.httpError(response);
    await this.readStream(response.body, onEvent, text => this.server.redact(text, response));
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: CompletionStreamEvent) => void,
    redact: (text: string) => string
  ) {
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();
    let stopReason: string | undefined;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
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
        if (typeof reasoning === 'string' && reasoning)
          onEvent({ type: 'content', text: `<think>${reasoning}</think>` });
        if (typeof delta?.content === 'string' && delta.content) onEvent({ type: 'content', text: delta.content });
        for (const call of delta?.tool_calls ?? []) {
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
      },
    });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!failure) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
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
    onEvent({ type: 'content', stopReason: stopReason ?? 'stop', ...(usage ? { usage } : {}) });
  }

  private learnContexts(models: readonly InstalledModel[]): void {
    for (const model of models) {
      if (model.contextLength === undefined) continue;
      for (const name of [model.name, ...(model.aliases ?? [])]) this.contexts.set(name, model.contextLength);
    }
  }

  private setToolsOff(off: boolean): void {
    if (this.toolsOff === off) return;
    this.toolsOff = off;
    if (!off) this.told.clear();
    this.server.toolsChanged?.();
  }

  private async probeTools(model: string): Promise<'accepted' | 'refused' | null> {
    try {
      const response = await this.server.fetch(`${this.server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(TOOLS_PROBE_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          tools: [PROBE_TOOL],
        }),
      });
      if (response.ok) {
        await response.body?.cancel();
        return 'accepted';
      }
      if (await refusedTools(response)) return 'refused';
      await response.body?.cancel();
      return null;
    } catch {
      return null;
    }
  }

  private async llamaServerContext(signal?: AbortSignal): Promise<number | undefined> {
    try {
      const timeout = AbortSignal.timeout(PROPS_TIMEOUT_MS);
      const response = await this.server.fetch(`${this.server.baseUrl}/props`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown };
      return tokenCount(body.default_generation_settings?.n_ctx) || tokenCount(body.n_ctx) || undefined;
    } catch {
      return undefined;
    }
  }

  private modelName(modelId: string): string {
    const parsed = parseLocalModelId(modelId);
    if (parsed?.runtimeId !== this.server.runtimeId) throw new Error('Invalid local model id.');
    return parsed.model;
  }

  private async httpError(response: Response): Promise<Error> {
    if (response.status === 401 || response.status === 403)
      return new ServerCredentialsError(this.server.label, this.server.hasCredentials());
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

/**
 * llama-server without --jinja (500), vLLM without --enable-auto-tool-choice (400, `"auto" tool choice requires
 * --enable-auto-tool-choice and --tool-call-parser to be set`), and some proxies refuse a request that declares tools.
 */
async function refusedTools(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 500) return false;
  return /\btools?\b/i.test(await response.clone().text());
}
