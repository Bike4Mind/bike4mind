import type { IMessage, MessageContentObject } from '@bike4mind/common';

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  user?: string;
}

export interface B4MToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface TranslatedRequest {
  systemPrompt: string;
  messages: IMessage[];
  toolSchemas: B4MToolSchema[];
  modelId: string;
  options: {
    temperature?: number;
    maxTokens?: number;
  };
}

export function openaiRequestToB4M(req: OpenAIChatRequest): TranslatedRequest {
  let systemPrompt = '';
  const messages: IMessage[] = [];

  for (const m of req.messages) {
    if (m.role === 'system') {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${typeof m.content === 'string' ? m.content : ''}`
        : typeof m.content === 'string'
          ? m.content
          : '';
      continue;
    }

    if (m.role === 'tool') {
      if (!m.tool_call_id) continue;
      const last = messages[messages.length - 1];
      const resultBlock: MessageContentObject = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: m.content ?? '',
      };
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as MessageContentObject[]).push(resultBlock);
      } else {
        messages.push({ role: 'user', content: [resultBlock] });
      }
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const blocks: MessageContentObject[] = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const call of m.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          input = { _raw: call.function.arguments };
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input,
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    messages.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    });
  }

  const toolSchemas: B4MToolSchema[] = (req.tools ?? []).map(t => ({
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: (t.function.parameters as B4MToolSchema['parameters']) ?? {
      type: 'object',
      properties: {},
    },
  }));

  return {
    systemPrompt,
    messages,
    toolSchemas,
    modelId: req.model,
    options: {
      temperature: req.temperature,
      maxTokens: req.max_tokens,
    },
  };
}

export interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface OpenAiChunkInput {
  id: string;
  model: string;
  created?: number;
  contentDelta?: string;
  toolCallDeltas?: OpenAiToolCallDelta[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function openAiSseChunk(input: OpenAiChunkInput): string {
  const delta: Record<string, unknown> = {};
  if (input.contentDelta !== undefined) delta.content = input.contentDelta;
  if (input.toolCallDeltas && input.toolCallDeltas.length > 0) {
    delta.tool_calls = input.toolCallDeltas;
  }

  const chunk = {
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created ?? Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
    ...(input.usage ? { usage: input.usage } : {}),
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function openAiSseDone(): string {
  return 'data: [DONE]\n\n';
}

/**
 * The new tail to emit given the previously-emitted text `prev` and the latest
 * accumulated text `next`. Used to turn the backend's accumulated-reply callback
 * into incremental SSE deltas.
 *
 * - `next` extends `prev` -> the appended suffix.
 * - `next` is no longer than `prev` (no growth / a shrink) -> '' (nothing new).
 * - `next` diverges from `prev` (a replacement, not an append) -> '' as well.
 *   For a TTS consumer that has ALREADY spoken `prev`, re-emitting the whole of
 *   an unrelated `next` would make it speak duplicated/likely-stale content; it
 *   is safer to emit nothing and let the caller resync its baseline. Callers that
 *   strip reasoning upstream (the voice proxy) keep the stream monotonic, so this
 *   divergent branch is defensive rather than a normal path.
 */
export function diffAccumulated(prev: string, next: string): string {
  if (next.length <= prev.length) return '';
  if (next.startsWith(prev)) return next.slice(prev.length);
  return '';
}
