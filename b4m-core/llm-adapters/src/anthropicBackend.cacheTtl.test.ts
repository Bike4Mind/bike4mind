import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage, type TurnUsage } from '@bike4mind/common';
import { AnthropicBackend, appendAnthropicTurn } from './anthropicBackend';

type Block = { type: string; text?: string; cache_control?: unknown };
type Captured = {
  system?: string | Block[];
  tools?: Array<{ cache_control?: unknown }>;
  messages: Array<{ role: string; content: string | Block[] }>;
};

const strategy = (cacheTTL: '5m' | '1h'): ICacheStrategy => ({
  enableCaching: true,
  cacheSystemPrompt: true,
  cacheTools: false,
  cacheConversationHistory: true,
  cacheTTL,
});

const messages: IMessage[] = [
  { role: 'system', content: 'stable head', cache: true },
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'earlier answer', cache: true },
  { role: 'user', content: 'the prompt' },
];

const capture = async (cacheTTL: '5m' | '1h') => {
  const backend = new AnthropicBackend('test-key');
  const captured: Captured[] = [];
  const infos: Array<{ turnUsage?: TurnUsage[] }> = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (params: Captured) => {
        captured.push(params);
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_creation_input_tokens: 1200,
            cache_creation: {
              ephemeral_5m_input_tokens: cacheTTL === '1h' ? 0 : 1200,
              ephemeral_1h_input_tokens: cacheTTL === '1h' ? 1200 : 0,
            },
          },
        };
      },
    },
  };
  await backend.complete(
    ChatModels.CLAUDE_4_8_OPUS,
    messages,
    { stream: false, tools: [], cacheStrategy: strategy(cacheTTL) },
    async (_text, info) => {
      if (info) infos.push(info as { turnUsage?: TurnUsage[] });
    }
  );
  return { request: captured[0], turnUsage: infos.findLast(i => i.turnUsage)?.turnUsage };
};

const controls = (request: Captured): unknown[] => {
  const found: unknown[] = [];
  const visit = (blocks: string | Block[] | undefined) => {
    if (Array.isArray(blocks)) for (const b of blocks) if (b.cache_control) found.push(b.cache_control);
  };
  visit(request.system);
  for (const m of request.messages) visit(m.content);
  return found;
};

describe('AnthropicBackend cache TTL', () => {
  it('puts the 1-hour TTL on every breakpoint, flagged ones included', async () => {
    const { request } = await capture('1h');
    const all = controls(request);
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const control of all) expect(control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('leaves the 5-minute default implicit', async () => {
    const { request } = await capture('5m');
    for (const control of controls(request)) expect(control).toEqual({ type: 'ephemeral' });
  });

  it('records the 1-hour part of each turn from usage.cache_creation', async () => {
    expect((await capture('1h')).turnUsage?.[0]).toMatchObject({
      cacheCreationInputTokens: 1200,
      cacheWrite1hInputTokens: 1200,
    });
    expect((await capture('5m')).turnUsage?.[0]).toMatchObject({
      cacheCreationInputTokens: 1200,
      cacheWrite1hInputTokens: 0,
    });
  });
});

describe('appendAnthropicTurn', () => {
  it('leaves the split unset when the provider sent none', () => {
    const [turn] = appendAnthropicTurn(undefined, { input_tokens: 1, cache_creation_input_tokens: 50 });
    expect(turn.cacheWrite1hInputTokens).toBeUndefined();
  });
});
