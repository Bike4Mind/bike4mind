import { StringDecoder } from 'node:string_decoder';
import type { ChatModelOption } from '@shared/chat';
import type { CompletionMessage, CompletionRequest } from './completions';
import type { CompletionStreamEvent } from './streamEvents';

export const LOCAL_MODEL_PREFIX = 'local:ollama:';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const TIMEOUT_MS = 1_000;

export class OllamaLocal {
  async models(): Promise<ChatModelOption[]> {
    const tags = (await this.json('/api/tags').catch(() => null)) as { models?: { name?: unknown }[] } | null;
    if (!Array.isArray(tags?.models)) return [];
    return (
      await Promise.all(tags.models.flatMap(row => (typeof row.name === 'string' ? [this.model(row.name)] : [])))
    ).filter((model): model is ChatModelOption => model !== null);
  }

  async stream(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const model = request.model.startsWith(LOCAL_MODEL_PREFIX) ? request.model.slice(LOCAL_MODEL_PREFIX.length) : '';
    if (!model) throw new Error('Invalid local model id.');
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        messages: request.messages.map(toMessage),
        ...(request.tools?.length
          ? { tools: request.tools.map(tool => ({ type: 'function', function: tool.toolSchema })) }
          : {}),
      }),
    });
    if (!response.ok || !response.body) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new StringDecoder('utf8');
    let pending = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.write(Buffer.from(value));
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) emitFrame(JSON.parse(line), onEvent);
    }
    if (pending.trim()) emitFrame(JSON.parse(pending), onEvent);
  }

  private async model(name: string): Promise<ChatModelOption | null> {
    const show = (await this.json('/api/show', { name }).catch(() => null)) as {
      capabilities?: unknown;
      model_info?: unknown;
    } | null;
    const capabilities = Array.isArray(show?.capabilities)
      ? show.capabilities.filter((x): x is string => typeof x === 'string')
      : [];
    const info =
      show?.model_info && typeof show.model_info === 'object' ? (show.model_info as Record<string, unknown>) : {};
    const contextWindow = Object.entries(info).find(
      ([key, value]) => key.endsWith('.context_length') && typeof value === 'number'
    )?.[1];
    return {
      id: `${LOCAL_MODEL_PREFIX}${name}`,
      name,
      backend: 'local-ollama',
      supportsTools: capabilities.includes('tools'),
      supportsVision: capabilities.includes('vision'),
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      ...(capabilities.includes('thinking') ? { thinkingToggle: true } : {}),
    };
  }

  private async json(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${OLLAMA_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    return response.json();
  }
}

function toMessage(message: CompletionMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
  };
}

function emitFrame(frame: unknown, onEvent: (event: CompletionStreamEvent) => void): void {
  if (!frame || typeof frame !== 'object') return;
  const raw = frame as {
    done?: unknown;
    done_reason?: unknown;
    message?: { content?: unknown; thinking?: unknown; tool_calls?: unknown[] };
  };
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
  if (raw.done === true) onEvent({ type: 'content', stopReason: String(raw.done_reason ?? 'end_turn') });
}
