/**
 * Anthropic rejects a request carrying more than four `cache_control` markers, and this backend
 * stamps them from independent places (each `cache: true` system message, each `cache: true`
 * user/assistant message, applyCaching). The request that goes out must never exceed the cap.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

type Block = { type: string; text?: string; cache_control?: unknown };
type Captured = { system?: string | Block[]; messages: Array<{ role: string; content: string | Block[] }> };

function buildCapturingBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: Captured[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (params: Captured) => {
        captured.push(params);
        return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return { backend, captured };
}

function markerCount(request: Captured): number {
  const system = Array.isArray(request.system) ? request.system.filter(b => b.cache_control).length : 0;
  const messages = request.messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.filter(b => b.cache_control).length : 0),
    0
  );
  return system + messages;
}

function texts(request: Captured): string[] {
  const system = Array.isArray(request.system) ? request.system.map(b => b.text ?? '') : [request.system ?? ''];
  const messages = request.messages.flatMap(m =>
    typeof m.content === 'string' ? [m.content] : m.content.map(b => b.text ?? '')
  );
  return [...system, ...messages];
}

const MODEL = ChatModels.CLAUDE_4_8_OPUS;

const overBudget: IMessage[] = [
  { role: 'system', content: 'shared head', cache: true },
  { role: 'system', content: 'retrieval one', cache: true },
  { role: 'system', content: 'retrieval two', cache: true },
  { role: 'system', content: 'session', cache: true },
  { role: 'user', content: 'u1', cache: true },
  { role: 'assistant', content: 'a1', cache: true },
  { role: 'user', content: 'u2', cache: true },
];

describe('AnthropicBackend cache_control cap', () => {
  it('sends at most four markers, keeping the latest message and end-of-system breakpoints', async () => {
    const { backend, captured } = buildCapturingBackend();

    await backend.complete(MODEL, overBudget, { stream: false, tools: [] }, async () => {});

    const request = captured[0];
    expect(markerCount(request)).toBe(4);
    const system = request.system as Block[];
    expect(system.filter(b => b.cache_control).map(b => b.text)).toEqual(['shared head', 'retrieval one', 'session']);
    const last = request.messages[request.messages.length - 1].content as Block[];
    expect(last[last.length - 1].cache_control).toBeDefined();
    for (const block of ['shared head', 'retrieval one', 'retrieval two', 'session', 'u1', 'a1', 'u2']) {
      expect(texts(request)).toContain(block);
    }
  });

  it('stays under the cap when applyCaching is also on', async () => {
    const { backend, captured } = buildCapturingBackend();
    const cacheStrategy: ICacheStrategy = {
      enableCaching: true,
      cacheSystemPrompt: true,
      cacheTools: true,
      cacheConversationHistory: true,
      cacheTTL: '5m',
    };

    await backend.complete(MODEL, overBudget, { stream: false, tools: [], cacheStrategy }, async () => {});

    expect(markerCount(captured[0])).toBeLessThanOrEqual(4);
  });

  it('leaves every marker in place when the request is within the cap', async () => {
    const { backend, captured } = buildCapturingBackend();

    await backend.complete(
      MODEL,
      [
        { role: 'system', content: 'shared head', cache: true },
        { role: 'system', content: 'session', cache: true },
        { role: 'user', content: 'u1', cache: true },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2', cache: true },
      ],
      { stream: false, tools: [] },
      async () => {}
    );

    expect(markerCount(captured[0])).toBe(4);
  });
});
