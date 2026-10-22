import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { capCacheControlMarkers } from './anthropic';

const CC = { type: 'ephemeral' };

type Block = Record<string, unknown>;

function stripAll(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAll);
  if (value && typeof value === 'object') {
    const { cache_control: _removed, ...rest } = value as Block;
    return Object.fromEntries(Object.entries(rest).map(([key, inner]) => [key, stripAll(inner)]));
  }
  return value;
}

function markedPaths(params: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const visit = (blocks: unknown, prefix: string) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((b, i) => {
      if ((b as Block).cache_control) paths.push(`${prefix}[${i}]`);
    });
  };
  visit(params.tools, 'tools');
  visit(params.system, 'system');
  (params.messages as Array<{ content: unknown }>).forEach((m, mi) => visit(m.content, `messages[${mi}].content`));
  return paths;
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

/** 7 markers: 1 tool, 3 system, 3 message (one on an image block). */
function overBudgetRequest(): Record<string, unknown> {
  return {
    model: 'claude',
    tools: [
      { name: 'a', input_schema: {} },
      { name: 'b', input_schema: {}, cache_control: CC },
    ],
    system: [
      { type: 'text', text: 'shared head', cache_control: CC },
      { type: 'text', text: 'retrieval', cache_control: CC },
      { type: 'text', text: 'session', cache_control: CC },
      { type: 'text', text: 'identity' },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, cache_control: CC },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'a1', cache_control: CC }] },
      { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: CC }] },
    ],
  };
}

describe('capCacheControlMarkers', () => {
  it('returns the same object when at or under the cap', () => {
    const logger = makeLogger();
    const params = {
      tools: [{ name: 'a', input_schema: {}, cache_control: CC }],
      system: [{ type: 'text', text: 's', cache_control: CC }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: CC }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1', cache_control: CC }] },
      ],
    };
    const snapshot = structuredClone(params);

    expect(capCacheControlMarkers(params, logger as unknown as Logger)).toBe(params);
    expect(params).toEqual(snapshot);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves a string system and string message content alone', () => {
    const params = { system: 'plain', messages: [{ role: 'user', content: 'hi' }] };
    expect(capCacheControlMarkers(params)).toBe(params);
  });

  it('keeps at most four, preferring latest message, last system, earliest system, then newer messages', () => {
    const params = overBudgetRequest();
    const snapshot = structuredClone(params);
    const logger = makeLogger();

    const capped = capCacheControlMarkers(params, logger as unknown as Logger);

    expect(markedPaths(capped)).toEqual(['system[0]', 'system[1]', 'system[2]', 'messages[2].content[0]']);
    // Tool and image markers count toward the cap and are the first to go here.
    expect(markedPaths(capped)).not.toContain('tools[1]');
    expect(markedPaths(capped)).not.toContain('messages[0].content[1]');
    expect(stripAll(capped)).toEqual(stripAll(snapshot));
    expect(params).toEqual(snapshot);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('stripped 3');
  });

  it('prefers newer message markers over older ones and over tools when system has none', () => {
    const params = {
      tools: [{ name: 'a', input_schema: {}, cache_control: CC }],
      messages: [1, 2, 3, 4, 5].map(n => ({
        role: n % 2 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `m${n}`, cache_control: CC }],
      })),
    };

    const capped = capCacheControlMarkers(params);

    expect(markedPaths(capped)).toEqual([
      'messages[1].content[0]',
      'messages[2].content[0]',
      'messages[3].content[0]',
      'messages[4].content[0]',
    ]);
  });

  it('counts and strips markers nested inside a tool_result body', () => {
    const params = {
      system: [1, 2, 3].map(n => ({ type: 'text', text: `s${n}`, cache_control: CC })),
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: 'r1', cache_control: CC },
                { type: 'text', text: 'r2' },
              ],
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
        { role: 'user', content: [{ type: 'text', text: 'u3', cache_control: CC }] },
      ],
    };
    const snapshot = structuredClone(params);
    const logger = makeLogger();

    const capped = capCacheControlMarkers(params, logger as unknown as Logger);

    const toolResult = (capped.messages as Array<{ content: Block[] }>)[1].content[0];
    expect((toolResult.content as Block[])[0]).toEqual({ type: 'text', text: 'r1' });
    expect(toolResult.tool_use_id).toBe('t1');
    expect(markedPaths(capped)).toEqual(['system[0]', 'system[1]', 'system[2]', 'messages[3].content[0]']);
    expect(logger.warn.mock.calls[0][0]).toContain('messages[1].content[0].content[0]');
    expect(stripAll(capped)).toEqual(stripAll(snapshot));
    expect(params).toEqual(snapshot);
  });

  it('strips only the marker key and leaves untouched regions by reference', () => {
    const params = {
      system: [1, 2, 3, 4, 5].map(n => ({ type: 'text', text: `s${n}`, cache_control: CC, citations: null })),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };

    const capped = capCacheControlMarkers(params);

    const system = capped.system as Block[];
    expect(system.filter(b => b.cache_control).length).toBe(4);
    expect(system[3]).toEqual({ type: 'text', text: 's4', citations: null });
    expect(capped.messages).toBe(params.messages);
  });
});
