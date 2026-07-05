import { describe, it, expect } from 'vitest';
import type { MessageContentObject } from '@bike4mind/common';
import {
  openaiRequestToB4M,
  openAiSseChunk,
  openAiSseDone,
  diffAccumulated,
  type OpenAIChatRequest,
} from './translator';

describe('openaiRequestToB4M', () => {
  it('extracts system prompt and pure text messages', () => {
    const req: OpenAIChatRequest = {
      model: 'claude-sonnet-4-5-20250929',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi there' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ],
    };

    const out = openaiRequestToB4M(req);

    expect(out.systemPrompt).toBe('You are helpful.');
    expect(out.modelId).toBe('claude-sonnet-4-5-20250929');
    expect(out.messages).toEqual([
      { role: 'user', content: 'Hi there' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
    ]);
    expect(out.toolSchemas).toEqual([]);
  });

  it('concatenates multiple system messages', () => {
    const req: OpenAIChatRequest = {
      model: 'gpt-4.1-2025-04-14',
      messages: [
        { role: 'system', content: 'System A' },
        { role: 'system', content: 'System B' },
        { role: 'user', content: 'Hi' },
      ],
    };
    const out = openaiRequestToB4M(req);
    expect(out.systemPrompt).toBe('System A\n\nSystem B');
  });

  it('translates assistant tool_calls into canonical tool_use blocks', () => {
    const req: OpenAIChatRequest = {
      model: 'claude-sonnet-4-5-20250929',
      messages: [
        { role: 'user', content: 'Weather in SF?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'weather_info', arguments: '{"lat":37.77,"lon":-122.42}' },
            },
          ],
        },
      ],
    };

    const out = openaiRequestToB4M(req);

    expect(out.messages).toHaveLength(2);
    const assistantMsg = out.messages[1];
    expect(assistantMsg.role).toBe('assistant');
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const blocks = assistantMsg.content as MessageContentObject[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'Let me check.' });
    expect(blocks[1]).toEqual({
      type: 'tool_use',
      id: 'call_abc',
      name: 'weather_info',
      input: { lat: 37.77, lon: -122.42 },
    });
  });

  it('translates role:tool messages into canonical tool_result blocks on a user message', () => {
    const req: OpenAIChatRequest = {
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'Search please' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'web_search', arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result text' },
      ],
    };

    const out = openaiRequestToB4M(req);

    expect(out.messages).toHaveLength(3);
    const toolResultMsg = out.messages[2];
    expect(toolResultMsg.role).toBe('user');
    const blocks = toolResultMsg.content as MessageContentObject[];
    expect(blocks).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: 'result text' }]);
  });

  it('coalesces multiple consecutive tool results onto a single user message', () => {
    const req: OpenAIChatRequest = {
      model: 'claude-sonnet-4-5-20250929',
      messages: [
        { role: 'user', content: 'two things' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 't', arguments: '{}' } },
            { id: 'b', type: 'function', function: { name: 't', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: 'A done' },
        { role: 'tool', tool_call_id: 'b', content: 'B done' },
      ],
    };

    const out = openaiRequestToB4M(req);
    expect(out.messages).toHaveLength(3);
    const blocks = out.messages[2].content as MessageContentObject[];
    expect(blocks).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'A done' },
      { type: 'tool_result', tool_use_id: 'b', content: 'B done' },
    ]);
  });

  it('extracts tool schemas with parameters', () => {
    const req: OpenAIChatRequest = {
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Search the web',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string', description: 'query' } },
              required: ['q'],
            },
          },
        },
      ],
    };

    const out = openaiRequestToB4M(req);
    expect(out.toolSchemas).toEqual([
      {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'query' } },
          required: ['q'],
        },
      },
    ]);
  });

  it('passes through temperature and max_tokens', () => {
    const req: OpenAIChatRequest = {
      model: 'gpt-4.1-2025-04-14',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      max_tokens: 500,
    };
    const out = openaiRequestToB4M(req);
    expect(out.options).toEqual({ temperature: 0.3, maxTokens: 500 });
  });

  it('tolerates malformed tool_call argument JSON', () => {
    const req: OpenAIChatRequest = {
      model: 'claude-sonnet-4-5-20250929',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: 'not-json' } }],
        },
      ],
    };
    const out = openaiRequestToB4M(req);
    const blocks = out.messages[0].content as MessageContentObject[];
    expect(blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'c',
      name: 't',
      input: { _raw: 'not-json' },
    });
  });
});

describe('openAiSseChunk', () => {
  it('emits a text content delta frame', () => {
    const frame = openAiSseChunk({
      id: 'chatcmpl-1',
      model: 'claude-sonnet-4-5-20250929',
      contentDelta: 'Hello',
      created: 1700000000,
    });
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const payload = JSON.parse(frame.slice('data: '.length).trim());
    expect(payload).toMatchObject({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'claude-sonnet-4-5-20250929',
      choices: [
        {
          index: 0,
          delta: { content: 'Hello' },
          finish_reason: null,
        },
      ],
    });
  });

  it('emits a tool_calls delta frame', () => {
    const frame = openAiSseChunk({
      id: 'chatcmpl-2',
      model: 'gemini-2.5-flash',
      toolCallDeltas: [
        {
          index: 0,
          id: 'call_xyz',
          type: 'function',
          function: { name: 'web_search', arguments: '{"q":"sf weather"}' },
        },
      ],
      finishReason: 'tool_calls',
    });
    const payload = JSON.parse(frame.slice('data: '.length).trim());
    expect(payload.choices[0]).toEqual({
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call_xyz',
            type: 'function',
            function: { name: 'web_search', arguments: '{"q":"sf weather"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  it('emits a terminal stop chunk with usage', () => {
    const frame = openAiSseChunk({
      id: 'chatcmpl-3',
      model: 'gpt-4.1-2025-04-14',
      finishReason: 'stop',
      usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
    });
    const payload = JSON.parse(frame.slice('data: '.length).trim());
    expect(payload.choices[0].finish_reason).toBe('stop');
    expect(payload.usage).toEqual({ prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 });
  });
});

describe('openAiSseDone', () => {
  it('emits the SSE sentinel', () => {
    expect(openAiSseDone()).toBe('data: [DONE]\n\n');
  });
});

describe('diffAccumulated', () => {
  it('returns the suffix when next extends prev', () => {
    expect(diffAccumulated('Hello', 'Hello, world')).toBe(', world');
  });

  it('returns empty when next is no longer than prev', () => {
    expect(diffAccumulated('Hello', 'Hello')).toBe('');
    // Streaming text shouldn't shrink - treat shorter next as "no new content".
    expect(diffAccumulated('Hello', 'Hi')).toBe('');
  });

  it('returns the suffix when next still extends prev after a word boundary', () => {
    expect(diffAccumulated('Hello', 'Hello world replaced')).toBe(' world replaced');
  });

  it('returns empty when next diverges from prev (no re-speaking unrelated text)', () => {
    // Already-spoken `prev` must not be followed by the whole of an unrelated
    // `next` - that would double-speak. Emit nothing; caller resyncs baseline.
    expect(diffAccumulated('Hello', 'Goodbye there now')).toBe('');
  });

  it('returns full string when prev is empty', () => {
    expect(diffAccumulated('', 'first chunk')).toBe('first chunk');
  });
});
