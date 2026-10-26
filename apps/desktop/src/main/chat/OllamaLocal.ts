import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { localBackend, localModelId, parseLocalModelId, type ChatModelOption } from '@shared/chat';
import type { CompletionMessage, CompletionRequest } from './completions';
import type { CompletionStreamEvent } from './streamEvents';

export const OLLAMA_RUNTIME_ID = 'ollama';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const TIMEOUT_MS = 1_000;
const DEFAULT_CONTEXT_TOKENS = 4_096;
const remoteFields = { remote_host: z.string().optional(), remote_model: z.string().optional() };
const tagsSchema = z.object({ models: z.array(z.object({ name: z.string().min(1), ...remoteFields })) });
const showSchema = z.object({
  capabilities: z.array(z.string()),
  model_info: z.record(z.string(), z.unknown()).optional(),
  parameters: z.string().optional(),
  ...remoteFields,
});

function usesRemoteModel(model: { remote_host?: string; remote_model?: string }): boolean {
  return !!(model.remote_host?.trim() || model.remote_model?.trim());
}

export class OllamaLocal {
  async models(): Promise<ChatModelOption[]> {
    const tags = tagsSchema.safeParse(await this.json('/api/tags').catch(() => null));
    if (!tags.success) return [];
    return (
      await Promise.all(tags.data.models.filter(row => !usesRemoteModel(row)).map(row => this.model(row.name)))
    ).filter((model): model is ChatModelOption => model !== null);
  }

  async stream(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const parsed = parseLocalModelId(request.model);
    const model = parsed?.runtimeId === OLLAMA_RUNTIME_ID ? parsed.model : '';
    if (!model) throw new Error('Invalid local model id.');
    const inspection = showSchema.parse(await this.json('/api/show', { name: model }, signal));
    // A localhost daemon can proxy cloud models, including aliases without a cloud suffix.
    // Inspect again before sending private messages, even when discovery was cached.
    if (usesRemoteModel(inspection)) throw new Error('Cloud-backed Ollama models cannot be used as local models.');
    if (!inspection.capabilities.includes('completion')) throw new Error('This Ollama model cannot answer chat.');
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        messages: toMessages(request.messages),
        ...(request.thinking !== undefined && inspection.capabilities.includes('thinking')
          ? { think: request.thinking }
          : {}),
        options: {
          num_ctx: contextWindow(inspection),
          ...(request.maxTokens ? { num_predict: request.maxTokens } : {}),
        },
        ...(request.tools?.length
          ? { tools: request.tools.map(tool => ({ type: 'function', function: tool.toolSchema })) }
          : {}),
      }),
    });
    if (!response.ok || !response.body) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let completed = false;
    const consume = (line: string) => {
      if (line.trim()) completed = emitLine(line, onEvent) || completed;
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

  private async model(name: string): Promise<ChatModelOption | null> {
    const show = showSchema.safeParse(await this.json('/api/show', { name }).catch(() => null));
    // Embedding-only models cannot answer /api/chat; failed inspection is not a plain-text capability.
    if (!show.success || usesRemoteModel(show.data) || !show.data.capabilities.includes('completion')) return null;
    const capabilities = show.data.capabilities;
    return {
      id: localModelId(OLLAMA_RUNTIME_ID, name),
      name,
      backend: localBackend(OLLAMA_RUNTIME_ID),
      supportsTools: capabilities.includes('tools'),
      supportsVision: capabilities.includes('vision'),
      contextWindow: contextWindow(show.data),
      ...(capabilities.includes('thinking') ? { thinkingToggle: true } : {}),
    };
  }

  private async json(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${OLLAMA_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
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
function toMessages(messages: CompletionMessage[]): Record<string, unknown>[] {
  const toolNames = new Map<string, string>();
  return messages.flatMap(message => {
    if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
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

/** Keep the advertised limit equal to the allocation every inference actually requests. */
function contextWindow(inspection: z.infer<typeof showSchema>): number {
  const architectureLimit = Object.entries(inspection.model_info ?? {}).find(
    ([key, value]) => key.endsWith('.context_length') && positiveTokenCount(value) !== undefined
  )?.[1];
  const configured = /^num_ctx[ \t]+(\S+)[ \t]*$/m.exec(inspection.parameters ?? '')?.[1];
  const requested =
    positiveTokenCount(configured === undefined ? undefined : Number(configured)) ?? DEFAULT_CONTEXT_TOKENS;
  const maximum = positiveTokenCount(architectureLimit);
  return maximum === undefined ? requested : Math.min(requested, maximum);
}

function positiveTokenCount(value: unknown): number | undefined {
  const count = tokenCount(value);
  return count !== undefined && count > 0 && Number.isSafeInteger(count) ? count : undefined;
}
