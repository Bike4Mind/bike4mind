import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { localBackend, localModelId, parseLocalModelId, type ChatModelOption } from '@shared/chat';
import { AUTO_LOCAL_CONTEXT, type LocalContextSetting } from '@shared/localContextSetting';
import type { CompletionMessage, CompletionRequest } from './completions';
import {
  ContextOverflowError,
  estimateTokens,
  fitToContext,
  fitsInMemory,
  grownContextTokens,
  localContextTokens,
  memoryContextTokens,
  overflowTokens,
  type LocalModelFootprint,
  type OllamaMessage,
} from './localContext';
import type { CompletionStreamEvent } from './streamEvents';

export const OLLAMA_RUNTIME_ID = 'ollama';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const TIMEOUT_MS = 1_000;
const MAX_TRIM_RETRIES = 3;
const remoteFields = { remote_host: z.string().optional(), remote_model: z.string().optional() };
const tagsSchema = z.object({ models: z.array(z.object({ name: z.string().min(1), ...remoteFields })) });
const showSchema = z.object({
  capabilities: z.array(z.string()),
  model_info: z.record(z.string(), z.unknown()).optional(),
  parameters: z.string().optional(),
  ...remoteFields,
});

async function ollamaError(response: Response): Promise<Error> {
  const message = await httpError(response);
  // Ollama answers "model '...' not found" once the model is deleted, e.g. from the Models screen.
  if (response.status === 404 && /model .* not found/i.test(message))
    return new Error('This model was removed from Ollama. Pick another model.');
  return new Error(message);
}

function usesRemoteModel(model: { remote_host?: string; remote_model?: string }): boolean {
  return !!(model.remote_host?.trim() || model.remote_model?.trim());
}

const CHAT_URL = `${OLLAMA_URL}/api/chat` as const;

/** Typed to the chat URL alone, so the 1 s calls in json() cannot be routed through it. */
export type ChatFetch = (url: typeof CHAT_URL, init: RequestInit) => Promise<Response>;

/** Without one, every model runs at the fixed default of localContextTokens. */
export interface LocalContextSizing {
  setting(): Promise<LocalContextSetting>;
  /** By Ollama model name; fields it cannot measure are null. */
  footprint(model: string): Promise<LocalModelFootprint>;
}

type Inspection = z.infer<typeof showSchema>;

export class OllamaLocal {
  /**
   * Main passes Electron's net.fetch: Node's fetch gives up after five minutes without response
   * headers, and Ollama sends none until prefill ends, which takes that long for a CPU-only model.
   * Only chat uses it: Chromium allows 6 sockets per host and each open stream holds one, so the
   * short calls stay on Node's fetch, which a full pool cannot starve.
   */
  constructor(
    private readonly chatFetch: ChatFetch = (url, init) => globalThis.fetch(url, init),
    private readonly sizing?: LocalContextSizing
  ) {}

  async models(): Promise<ChatModelOption[]> {
    const tags = tagsSchema.safeParse(await this.json('/api/tags').catch(() => null));
    if (!tags.success) return [];
    return (
      await Promise.all(tags.data.models.filter(row => !usesRemoteModel(row)).map(row => this.model(row.name)))
    ).filter((model): model is ChatModelOption => model !== null);
  }

  /**
   * The num_ctx requests to this model are sent with, which is also the window the catalog
   * advertises; ChatService compacts and sizes summaries against it. Asks Ollama when not cached.
   */
  async contextTokens(modelId: string, signal?: AbortSignal): Promise<number> {
    const known = contextByModel.get(modelId);
    if (known !== undefined) return known;
    const name = ollamaModelName(modelId);
    return this.resolveContext(modelId, showSchema.parse(await this.json('/api/show', { name }, signal)));
  }

  async stream(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal?: AbortSignal,
    /** Called with how many of the oldest messages were left out because the prompt overflowed. */
    onTrimmed?: (dropped: number) => void
  ): Promise<void> {
    const model = ollamaModelName(request.model);
    const inspection = showSchema.parse(await this.json('/api/show', { name: model }, signal));
    // A localhost daemon can proxy cloud models, including aliases without a cloud suffix.
    // Inspect again before sending private messages, even when discovery was cached.
    if (usesRemoteModel(inspection)) throw new Error('Cloud-backed Ollama models cannot be used as local models.');
    if (!inspection.capabilities.includes('completion')) throw new Error('This Ollama model cannot answer chat.');
    let numCtx = await this.resolveContext(request.model, inspection);
    const messages = toMessages(request.messages);
    const tools = (request.tools ?? []).map(tool => ({ type: 'function', function: tool.toolSchema }));
    const post = (fitted: OllamaMessage[]) =>
      this.chatFetch(CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: fitted.map(({ continuesTurn: _continuesTurn, ...message }) => message),
          // Ollama's own truncation and its context shift (once prompt plus reply reach num_ctx) both
          // keep the first few tokens and the tail, cutting the system prompt. With shift off the
          // reply stops at num_ctx instead, as done_reason 'length' (a visible max_tokens stop).
          truncate: false,
          shift: false,
          ...(request.thinking !== undefined && inspection.capabilities.includes('thinking')
            ? { think: request.thinking }
            : {}),
          options: {
            num_ctx: numCtx,
            ...(request.maxTokens ? { num_predict: request.maxTokens } : {}),
          },
          ...(tools.length > 0 ? { tools } : {}),
        }),
      });
    // Everything goes out first: auto-compaction works from the measured size and must get its
    // chance before turns are dropped, which happens only once Ollama refuses the prompt.
    let sent = messages;
    let response = await post(sent);
    let measured = await refusedSize(response);
    let hint = '';
    if (measured !== undefined) {
      const growth = await this.grow(request.model, inspection, measured, request.maxTokens, numCtx);
      hint = growth.hint;
      if (growth.tokens !== undefined) {
        numCtx = growth.tokens;
        response = await post(sent);
        measured = await refusedSize(response);
      }
    }
    const whole = measured;
    let left = 0;
    for (let retry = 0; measured !== undefined; retry++) {
      // Rescaled from each refusal: the dropped turns need not be as token-dense as the kept ones.
      const fit = fitToContext(sent, tools, numCtx, request.maxTokens, (1.1 * measured) / estimateTokens(sent, tools));
      if (fit.dropped === 0)
        throw new ContextOverflowError(
          `This turn and Desktop's instructions take ${measured} tokens, more than the ${numCtx} this model is run with.${hint}`,
          measured,
          numCtx
        );
      if (retry === MAX_TRIM_RETRIES)
        throw new ContextOverflowError(
          `This conversation still takes ${measured} tokens after leaving out its ${left} oldest messages, more than the ${numCtx} this model is run with. Run /compact to summarise it.`,
          measured,
          numCtx
        );
      left += fit.visible;
      sent = fit.messages;
      response = await post(sent);
      measured = await refusedSize(response);
    }
    if (!response.ok || !response.body) throw await ollamaError(response);
    if (left > 0) onTrimmed?.(left);
    // Recorded now, not only on the done frame, so a reply stopped early still makes the next turn compact.
    if (whole !== undefined) onEvent({ type: 'content', usage: { inputTokens: whole } });
    // Report the whole conversation's size, so the next turn compacts instead of trimming again.
    const report: typeof onEvent =
      whole === undefined
        ? onEvent
        : event =>
            onEvent(
              event.type === 'content' && event.usage
                ? { ...event, usage: { ...event.usage, inputTokens: whole } }
                : event
            );
    const reader = response.body.getReader();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let completed = false;
    const consume = (line: string) => {
      if (line.trim()) completed = emitLine(line, report) || completed;
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.write(Buffer.from(value));
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) consume(line);
      }
      consume(pending + decoder.end());
      if (!completed) throw new Error('Ollama stream ended before the reply finished.');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  /**
   * Fixed: the Settings size, within the model's trained length. Auto: what fits this machine's
   * memory, or what a long prompt grew it to. The same inputs give the same figure every time, so
   * a model is not reloaded between messages.
   */
  private async resolveContext(modelId: string, inspection: Inspection): Promise<number> {
    const { limit, configured } = contextBounds(inspection);
    const setting = (await this.sizing?.setting()) ?? AUTO_LOCAL_CONTEXT;
    const tokens =
      setting.mode === 'fixed'
        ? Math.min(setting.tokens, limit ?? setting.tokens)
        : Math.max(
            localContextTokens(limit, configured, await this.memoryTokens(modelId)),
            grownByModel.get(modelId) ?? 0
          );
    contextByModel.set(modelId, tokens);
    return tokens;
  }

  private async memoryTokens(modelId: string): Promise<number | undefined> {
    return this.sizing ? memoryContextTokens(await this.sizing.footprint(ollamaModelName(modelId))) : undefined;
  }

  /** Under Auto, the larger context a refused prompt needs when the model and memory hold it; else why not. */
  private async grow(
    modelId: string,
    inspection: Inspection,
    measured: number,
    maxTokens: number | undefined,
    current: number
  ): Promise<{ tokens?: number; hint: string }> {
    if (!this.sizing) return { hint: '' };
    const setting = await this.sizing.setting();
    const { limit } = contextBounds(inspection);
    if (setting.mode === 'fixed')
      return {
        hint: limit === undefined || current < limit ? ' Settings can give local models a larger context.' : '',
      };
    const wanted = grownContextTokens(measured, maxTokens, limit);
    if (wanted === undefined || wanted <= current) return { hint: ' That is the most this model supports.' };
    const fits = fitsInMemory(await this.sizing.footprint(ollamaModelName(modelId)), wanted);
    if (fits === undefined) return { hint: '' };
    if (!fits) return { hint: " A larger context would not fit this computer's memory." };
    grownByModel.set(modelId, wanted);
    contextByModel.set(modelId, wanted);
    return { tokens: wanted, hint: '' };
  }

  private async model(name: string): Promise<ChatModelOption | null> {
    const show = showSchema.safeParse(await this.json('/api/show', { name }).catch(() => null));
    // Embedding-only models cannot answer /api/chat; failed inspection is not a plain-text capability.
    if (!show.success || usesRemoteModel(show.data) || !show.data.capabilities.includes('completion')) return null;
    const capabilities = show.data.capabilities;
    const id = localModelId(OLLAMA_RUNTIME_ID, name);
    return {
      id,
      name,
      backend: localBackend(OLLAMA_RUNTIME_ID),
      supportsTools: capabilities.includes('tools'),
      supportsVision: capabilities.includes('vision'),
      contextWindow: await this.resolveContext(id, show.data),
      ...(capabilities.includes('thinking') ? { thinkingToggle: true } : {}),
    };
  }

  private async json(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await globalThis.fetch(`${OLLAMA_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw await ollamaError(response);
    return response.json();
  }
}

type Block = {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  source?: { data?: unknown };
};

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => (block && typeof block === 'object' ? blockText((block as Block).text) : '')).join('');
}

/**
 * Maps the Anthropic-style blocks `ChatService` builds onto Ollama's chat format: tool calls on the
 * assistant message, one `role: 'tool'` message per result, screenshots in `images`.
 */
function toMessages(messages: CompletionMessage[]): OllamaMessage[] {
  const toolNames = new Map<string, string>();
  return messages.flatMap(message => {
    const continues = message.continuesTurn ? { continuesTurn: true } : {};
    if (typeof message.content === 'string') return [{ role: message.role, content: message.content, ...continues }];
    const blocks = message.content.filter((b): b is Block => !!b && typeof b === 'object');
    const text = blocks.map(block => (block.type === 'text' ? blockText(block.text) : '')).join('');
    const toolCalls = blocks.flatMap(block => {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') return [];
      if (typeof block.id === 'string') toolNames.set(block.id, block.name);
      return [{ function: { name: block.name, arguments: block.input ?? {} } }];
    });
    const results = blocks.flatMap(block =>
      block.type === 'tool_result'
        ? [
            {
              role: 'tool',
              content: blockText(block.content),
              ...(typeof block.tool_use_id === 'string' && toolNames.has(block.tool_use_id)
                ? { tool_name: toolNames.get(block.tool_use_id) }
                : {}),
            },
          ]
        : []
    );
    const images = blocks.flatMap(block =>
      block.type === 'image' && typeof block.source?.data === 'string' ? [block.source.data] : []
    );
    const own =
      text || toolCalls.length > 0 || images.length > 0
        ? [
            {
              role: message.role,
              content: text,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              ...(images.length > 0 ? { images } : {}),
              // Text riding on tool results is a note on them, not a new prompt.
              ...(results.length > 0 ? { continuesTurn: true } : continues),
            },
          ]
        : [];
    return [...results, ...own];
  });
}

function emitLine(line: string, onEvent: (event: CompletionStreamEvent) => void): boolean {
  if (!line.trim()) return false;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    throw new Error('Ollama returned a malformed stream frame.');
  }
  emitFrame(frame, onEvent);
  return !!frame && typeof frame === 'object' && 'done' in frame && frame.done === true;
}

function emitFrame(frame: unknown, onEvent: (event: CompletionStreamEvent) => void): void {
  if (!frame || typeof frame !== 'object') return;
  const raw = frame as {
    done?: unknown;
    done_reason?: unknown;
    error?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
    message?: { content?: unknown; thinking?: unknown; tool_calls?: unknown[] };
  };
  if (typeof raw.error === 'string') throw new Error(raw.error);
  if (typeof raw.message?.thinking === 'string' && raw.message.thinking)
    onEvent({ type: 'content', text: `<think>${raw.message.thinking}</think>` });
  if (typeof raw.message?.content === 'string' && raw.message.content)
    onEvent({ type: 'content', text: raw.message.content });
  const tools = (raw.message?.tool_calls ?? []).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const call = value as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    return typeof call.function?.name === 'string'
      ? [
          {
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments ?? {}),
            ...(typeof call.id === 'string' ? { id: call.id } : {}),
          },
        ]
      : [];
  });
  if (tools.length > 0) onEvent({ type: 'tool_use', tools });
  if (raw.done === true) {
    const stopReason = raw.done_reason === 'length' ? 'max_tokens' : String(raw.done_reason ?? 'end_turn');
    const inputTokens = tokenCount(raw.prompt_eval_count);
    const outputTokens = tokenCount(raw.eval_count);
    const usage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
    onEvent({
      type: 'content',
      stopReason,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    });
  }
}

/** A missing or invalid measurement must stay unknown rather than becoming zero. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)
    ? value
    : undefined;
}

async function httpError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const detail =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '';
  return `Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`;
}

async function refusedSize(response: Response): Promise<number | undefined> {
  return response.status === 400 ? overflowTokens(await response.clone().text()) : undefined;
}

function ollamaModelName(modelId: string): string {
  const parsed = parseLocalModelId(modelId);
  if (parsed?.runtimeId !== OLLAMA_RUNTIME_ID) throw new Error('Invalid local model id.');
  return parsed.model;
}

// Module-wide so every OllamaLocal instance (catalog, chat, tests) reads the same figure.
const contextByModel = new Map<string, number>();
/** Contexts Auto grew for a long prompt, kept for the app run so the model is not reloaded back down. */
const grownByModel = new Map<string, number>();

/** After the Settings choice changes: every model is sized again on its next request. */
export function forgetLocalContexts(): void {
  contextByModel.clear();
  grownByModel.clear();
}

/** The model's trained length and its Modelfile num_ctx, when they are valid counts. */
function contextBounds(inspection: Inspection): { limit: number | undefined; configured: number | undefined } {
  const architectureLimit = Object.entries(inspection.model_info ?? {}).find(
    ([key, value]) => key.endsWith('.context_length') && positiveTokenCount(value) !== undefined
  )?.[1];
  const configured = /^num_ctx[ \t]+(\S+)[ \t]*$/m.exec(inspection.parameters ?? '')?.[1];
  return {
    limit: positiveTokenCount(architectureLimit),
    configured: positiveTokenCount(configured === undefined ? undefined : Number(configured)),
  };
}

function positiveTokenCount(value: unknown): number | undefined {
  const count = tokenCount(value);
  return count !== undefined && count > 0 && Number.isSafeInteger(count) ? count : undefined;
}
