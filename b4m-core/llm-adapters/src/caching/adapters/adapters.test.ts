import { describe, it, expect, vi } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import { AnthropicCachingAdapter } from './anthropic';
import { getCachingAdapter, NoOpCachingAdapter } from './index';

describe('AnthropicCachingAdapter', () => {
  const adapter = new AnthropicCachingAdapter();
  const model = 'claude-4-sonnet';

  describe('extractCacheStats', () => {
    it('returns undefined when response has no usage', () => {
      expect(adapter.extractCacheStats({}, model)).toBeUndefined();
    });

    it('returns stats with all zeros when usage has no cache fields', () => {
      const response = {
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
        },
      };
      const stats = adapter.extractCacheStats(response, model);
      expect(stats).toBeDefined();
      expect(stats!.cacheReadTokens).toBe(0);
      expect(stats!.cacheWriteTokens).toBe(0);
      expect(stats!.uncachedTokens).toBe(1000);
      expect(stats!.totalInputTokens).toBe(1000);
      expect(stats!.cacheHitRate).toBe(0);
      expect(stats!.costSavingsPercent).toBe(0);
    });

    it('calculates correct stats for cache read only', () => {
      const response = {
        usage: {
          input_tokens: 200,
          cache_read_input_tokens: 180000,
        },
      };
      const stats = adapter.extractCacheStats(response, model)!;

      expect(stats.cacheReadTokens).toBe(180000);
      expect(stats.cacheWriteTokens).toBe(0);
      expect(stats.uncachedTokens).toBe(200);
      expect(stats.totalInputTokens).toBe(180200);
      expect(stats.providerMetadata?.hadCacheWrite).toBe(false);

      // Hit rate = 180000 / 180200 * 100 ≈ 99.89%
      expect(stats.cacheHitRate).toBeCloseTo(99.889, 2);
      // Cost savings = hitRate * 0.9
      expect(stats.costSavingsPercent).toBeCloseTo(89.9, 0);
      // Latency reduction = hitRate * 0.85
      expect(stats.estimatedLatencyReduction).toBeCloseTo(84.9, 0);
    });

    it('calculates correct stats for cache write only (first request)', () => {
      const response = {
        usage: {
          input_tokens: 500,
          cache_creation_input_tokens: 7000,
        },
      };
      const stats = adapter.extractCacheStats(response, model)!;

      expect(stats.cacheReadTokens).toBe(0);
      expect(stats.cacheWriteTokens).toBe(7000);
      expect(stats.uncachedTokens).toBe(500);
      expect(stats.totalInputTokens).toBe(7500);
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.costSavingsPercent).toBe(0);
      expect(stats.providerMetadata?.hadCacheWrite).toBe(true);
    });

    it('calculates correct stats for mixed read and write', () => {
      const response = {
        usage: {
          input_tokens: 300,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 2000,
        },
      };
      const stats = adapter.extractCacheStats(response, model)!;

      expect(stats.cacheReadTokens).toBe(10000);
      expect(stats.cacheWriteTokens).toBe(2000);
      expect(stats.uncachedTokens).toBe(300);
      expect(stats.totalInputTokens).toBe(12300);
      expect(stats.providerMetadata?.hadCacheWrite).toBe(true);

      // Hit rate = 10000 / 12300 * 100 ≈ 81.30%
      const expectedHitRate = (10000 / 12300) * 100;
      expect(stats.cacheHitRate).toBeCloseTo(expectedHitRate, 2);
      expect(stats.costSavingsPercent).toBeCloseTo(expectedHitRate * 0.9, 2);
      expect(stats.estimatedLatencyReduction).toBeCloseTo(expectedHitRate * 0.85, 2);
    });

    it('returns zero hit rate when all tokens are zero', () => {
      const response = {
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      const stats = adapter.extractCacheStats(response, model)!;

      expect(stats.totalInputTokens).toBe(0);
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.costSavingsPercent).toBe(0);
    });

    it('sets provider to Anthropic and passes model through', () => {
      const response = { usage: { input_tokens: 100 } };
      const stats = adapter.extractCacheStats(response, 'claude-4.5-sonnet')!;

      expect(stats.provider).toBe(ModelBackend.Anthropic);
      expect(stats.model).toBe('claude-4.5-sonnet');
    });
  });

  describe('applyCaching', () => {
    const cacheControl = { type: 'ephemeral' };

    it('returns params unchanged when caching is disabled', () => {
      const params = { messages: [{ role: 'user', content: 'hi' }] };
      expect(adapter.applyCaching(params, { enableCaching: false })).toBe(params);
    });

    it('marks the last tool when cacheTools is set', () => {
      const params = {
        tools: [{ name: 'a' }, { name: 'b' }],
      };
      const result = adapter.applyCaching(params, {
        enableCaching: true,
        cacheTools: true,
      });
      const tools = result.tools as Record<string, unknown>[];
      expect(tools[0].cache_control).toBeUndefined();
      expect(tools[1].cache_control).toEqual(cacheControl);
    });

    it('marks the last system block when cacheSystemPrompt is set', () => {
      const params = {
        system: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'last' },
        ],
      };
      const result = adapter.applyCaching(params, {
        enableCaching: true,
        cacheSystemPrompt: true,
      });
      const system = result.system as Record<string, unknown>[];
      expect(system[0].cache_control).toBeUndefined();
      expect(system[1].cache_control).toEqual(cacheControl);
    });

    it('places a moving breakpoint on the last message when history caching is on', () => {
      const params = {
        messages: [
          { role: 'user', content: 'task' },
          { role: 'assistant', content: [{ type: 'text', text: 'step 1' }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
              { type: 'text', text: 'continue' },
            ],
          },
        ],
      };
      const result = adapter.applyCaching(params, {
        enableCaching: true,
        cacheConversationHistory: true,
      });
      const messages = result.messages as { content: Record<string, unknown>[] }[];

      // Only the final message's final block carries the breakpoint; earlier
      // turns stay untouched so the API reads them as the cached prefix.
      expect(messages[0].content).toBe('task');
      expect(messages[1].content[0].cache_control).toBeUndefined();
      expect(messages[2].content[0].cache_control).toBeUndefined();
      expect(messages[2].content[1].cache_control).toEqual(cacheControl);
    });

    it('wraps a string-content last message into a marked text block', () => {
      const params = {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      };
      const result = adapter.applyCaching(params, {
        enableCaching: true,
        cacheConversationHistory: true,
      });
      const messages = result.messages as { content: unknown }[];
      expect(messages[1].content).toEqual([{ type: 'text', text: 'second', cache_control: cacheControl }]);
    });

    it('leaves messages untouched when history caching is off', () => {
      const params = {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      };
      const result = adapter.applyCaching(params, {
        enableCaching: true,
        cacheConversationHistory: false,
      });
      const messages = result.messages as { content: Record<string, unknown>[] }[];
      expect(messages[0].content[0].cache_control).toBeUndefined();
    });

    it('applies the 1h ttl to breakpoints when requested', () => {
      const params = { tools: [{ name: 'only' }] };
      const result = adapter.applyCaching(params, {
        enableCaching: true,
        cacheTools: true,
        cacheTTL: '1h',
      });
      const tools = result.tools as Record<string, unknown>[];
      expect(tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    });

    it('anchors the history breakpoint before excluded trailing messages instead of the last one', () => {
      const params = {
        messages: [
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
          { role: 'user', content: 'volatile reminder, rebuilt every iteration' },
        ],
      };
      const result = adapter.applyCaching(params, {
        enableCaching: true,
        cacheConversationHistory: true,
        historyCacheExcludeTrailingCount: 1,
      });

      const messages = result.messages as Record<string, unknown>[];
      // The excluded trailing message is left untouched...
      expect(messages[2].content).toBe('volatile reminder, rebuilt every iteration');
      // ...and the breakpoint lands on the message before it instead.
      const anchorContent = messages[1].content as Record<string, unknown>[];
      expect(anchorContent[0].cache_control).toEqual(cacheControl);
    });

    it('skips history caching entirely when historyCacheExcludeTrailingCount covers the whole array', () => {
      const params = { messages: [{ role: 'user', content: 'only message' }] };
      const result = adapter.applyCaching(params, {
        enableCaching: true,
        cacheConversationHistory: true,
        historyCacheExcludeTrailingCount: 1,
      });

      const messages = result.messages as Record<string, unknown>[];
      expect(messages[0].content).toBe('only message');
    });
  });

  /**
   * Anthropic rejects a request carrying more than four cache_control markers with a
   * non-retryable ValidationException, losing the whole turn. Upstream callers attach their
   * own markers before this adapter runs (bedrockBackend marks every system block flagged
   * `cache: true`), so the adapter's three breakpoints are not free to add unconditionally.
   */
  describe('applyCaching cache_control budget', () => {
    const allBreakpoints = {
      enableCaching: true,
      cacheTools: true,
      cacheSystemPrompt: true,
      cacheConversationHistory: true,
    } as const;

    /**
     * Every cache_control marker on an outgoing request, wherever it may sit. Counts the VALUE,
     * matching what the provider counts - an explicit `cache_control: undefined` is not a marker.
     */
    const countMarkers = (params: Record<string, unknown>): number => {
      const marked = (block: unknown) =>
        !!block && typeof block === 'object' && !!(block as Record<string, unknown>).cache_control;
      let count = 0;
      if (Array.isArray(params.tools)) count += params.tools.filter(marked).length;
      if (Array.isArray(params.system)) count += params.system.filter(marked).length;
      if (Array.isArray(params.messages)) {
        for (const message of params.messages as Record<string, unknown>[]) {
          if (Array.isArray(message?.content)) count += (message.content as unknown[]).filter(marked).length;
        }
      }
      return count;
    };

    it('adds all three breakpoints when the request arrives with none', () => {
      const result = adapter.applyCaching(
        {
          tools: [{ name: 'a' }],
          system: [{ type: 'text', text: 'prefix' }],
          messages: [{ role: 'user', content: 'hi' }],
        },
        allBreakpoints
      );

      expect(countMarkers(result)).toBe(3);
    });

    it('never exceeds four markers when upstream already attached two', () => {
      const result = adapter.applyCaching(
        {
          tools: [{ name: 'a' }],
          // Two mid-stack breakpoints declared by the backend, as bedrockBackend does.
          system: [
            { type: 'text', text: 'shared head', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'authored prompt', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'identity reminder' },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        allBreakpoints
      );

      expect(countMarkers(result)).toBeLessThanOrEqual(4);
    });

    it('drops the history anchor first, keeping the durable system and tool breakpoints', () => {
      const result = adapter.applyCaching(
        {
          tools: [{ name: 'a' }],
          system: [
            { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'tail' },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        allBreakpoints
      );

      const system = result.system as Record<string, unknown>[];
      const tools = result.tools as Record<string, unknown>[];
      const messages = result.messages as Record<string, unknown>[];

      // Budget was 2: system tail and tools claim it, history goes without.
      expect(system[2].cache_control).toBeDefined();
      expect(tools[0].cache_control).toBeDefined();
      expect(messages[0].content).toBe('hi');
      expect(countMarkers(result)).toBe(4);
    });

    it('re-marking an already-marked block costs no budget', () => {
      // The system tail already carries a marker, so claiming it is free and the remaining
      // budget still covers both tools and history.
      const result = adapter.applyCaching(
        {
          tools: [{ name: 'a' }],
          system: [
            { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'tail', cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        allBreakpoints
      );

      const tools = result.tools as Record<string, unknown>[];
      const messages = result.messages as Record<string, unknown>[];
      expect(tools[0].cache_control).toBeDefined();
      expect((messages[0].content as Record<string, unknown>[])[0].cache_control).toBeDefined();
      expect(countMarkers(result)).toBe(4);
    });

    it('stays within budget on the post-tool-call request, the shape that failed in production', () => {
      // The turn that tripped the ceiling: a long system stack with two declared breakpoints,
      // a full tool roster, and a history grown past a tool round-trip so the anchor lands on
      // its own block rather than coinciding with an existing marker.
      const result = adapter.applyCaching(
        {
          tools: Array.from({ length: 11 }, (_, i) => ({ name: `tool_${i}` })),
          system: [
            { type: 'text', text: 'identity', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'authored', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'session' },
          ],
          messages: [
            { role: 'user', content: 'broad scenario' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'tool_0', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
          ],
        },
        allBreakpoints
      );

      expect(countMarkers(result)).toBeLessThanOrEqual(4);
    });

    it('logs the skipped breakpoints, with a census of where the markers sit', () => {
      const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      adapter.applyCaching(
        {
          tools: [{ name: 'a' }],
          system: [
            { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'tail' },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        allBreakpoints,
        logger as unknown as Parameters<typeof adapter.applyCaching>[2]
      );

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
      const [message, detail] = logger.warn.mock.calls[0];
      expect(message).toContain('budget exhausted');
      expect((detail as { dropped: string[] }).dropped).toEqual(['history']);
      expect((detail as { outbound: { total: number } }).outbound.total).toBe(4);
    });

    /**
     * The case the original incident hit: the request arrives already over the ceiling, so there
     * is nothing to subtract and the provider will reject it regardless. The adapter must not add
     * to it, and must say so loudly - a bare ValidationException gave no way to find the source.
     */
    it('reports an error, and adds nothing, when the request is already over the cap on arrival', () => {
      const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const marker = { type: 'ephemeral' };
      const result = adapter.applyCaching(
        {
          tools: [{ name: 'a', cache_control: marker }],
          system: [
            { type: 'text', text: '1', cache_control: marker },
            { type: 'text', text: '2', cache_control: marker },
            { type: 'text', text: '3', cache_control: marker },
            { type: 'text', text: '4', cache_control: marker },
            { type: 'text', text: 'tail' },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        allBreakpoints,
        logger as unknown as Parameters<typeof adapter.applyCaching>[2]
      );

      // Five arrived; the adapter adds none of its three.
      expect(countMarkers(result)).toBe(5);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [message, detail] = logger.error.mock.calls[0];
      expect(message).toContain('exceeds');
      const census = detail as { inbound: { system: number; tools: number }; outbound: { total: number } };
      expect(census.inbound.system).toBe(4);
      expect(census.inbound.tools).toBe(1);
      expect(census.outbound.total).toBe(5);
    });

    it('does not count a block whose cache_control is explicitly undefined', () => {
      const result = adapter.applyCaching(
        {
          system: [
            { type: 'text', text: 'a', cache_control: undefined },
            { type: 'text', text: 'b', cache_control: undefined },
            { type: 'text', text: 'c', cache_control: undefined },
            { type: 'text', text: 'd', cache_control: undefined },
            { type: 'text', text: 'tail' },
          ],
          tools: [{ name: 'a' }],
          messages: [{ role: 'user', content: 'hi' }],
        },
        allBreakpoints
      );

      // None of those undefined keys is a real marker, so the full budget was still available.
      expect(countMarkers(result)).toBe(3);
    });

    it('leaves an over-budget request untouched rather than adding a fifth marker', () => {
      const params = {
        tools: [{ name: 'a' }],
        system: [
          { type: 'text', text: '1', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: '2', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: '3', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: '4', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'tail' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      };
      const result = adapter.applyCaching(params, allBreakpoints);

      expect(countMarkers(result)).toBe(4);
      const system = result.system as Record<string, unknown>[];
      expect(system[4].cache_control).toBeUndefined();
    });
  });
});

describe('getCachingAdapter', () => {
  it('returns AnthropicCachingAdapter for Anthropic backend', () => {
    const adapter = getCachingAdapter(ModelBackend.Anthropic);
    expect(adapter).toBeInstanceOf(AnthropicCachingAdapter);
  });

  it('returns AnthropicCachingAdapter for Bedrock backend (uses same format)', () => {
    const adapter = getCachingAdapter(ModelBackend.Bedrock);
    expect(adapter).toBeInstanceOf(AnthropicCachingAdapter);
  });

  it('returns NoOpCachingAdapter for Ollama backend', () => {
    const adapter = getCachingAdapter(ModelBackend.Ollama);
    expect(adapter).toBeInstanceOf(NoOpCachingAdapter);
  });

  it('NoOpCachingAdapter.extractCacheStats always returns undefined', () => {
    const adapter = new NoOpCachingAdapter();
    expect(adapter.extractCacheStats({} as Record<string, unknown>, 'any-model')).toBeUndefined();
  });

  it('NoOpCachingAdapter.applyCaching returns params unchanged', () => {
    const adapter = new NoOpCachingAdapter();
    const params = { foo: 'bar' };
    expect(adapter.applyCaching(params, {} as never)).toBe(params);
  });
});
