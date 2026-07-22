import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition } from '@bike4mind/services';
import { guardDecomposeOnce, DECOMPOSE_ALREADY_DONE_MSG } from './decomposeGuard';

// Minimal fake tool: implementation() returns a toolFn that records its calls.
function fakeDecompose(): { tool: ToolDefinition; calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    name: 'optihashi_decompose',
    implementation: () => ({
      toolFn: async (params?: unknown) => {
        calls.push(params);
        return 'PLAN CREATED';
      },
      toolSchema: { name: 'optihashi_decompose', description: '', parameters: { type: 'object', properties: {} } },
    }),
  } as unknown as ToolDefinition;
  return { tool, calls };
}

const run = (t: ToolDefinition, params?: unknown) => t.implementation({} as never, undefined).toolFn(params);

describe('guardDecomposeOnce', () => {
  it('runs the real decompose on the FIRST call', async () => {
    const { tool, calls } = fakeDecompose();
    const state = { decomposeUsed: false };
    const guarded = guardDecomposeOnce({ optihashi_decompose: tool }, state);
    const out = await run(guarded.optihashi_decompose, { scenario: 'x' });
    expect(out).toBe('PLAN CREATED');
    expect(calls).toHaveLength(1);
    expect(state.decomposeUsed).toBe(true);
  });

  it('blocks a SECOND call with the redirect message and does not re-run decompose', async () => {
    const { tool, calls } = fakeDecompose();
    const state = { decomposeUsed: false };
    const onBlocked = vi.fn();
    const guarded = guardDecomposeOnce({ optihashi_decompose: tool }, state, onBlocked);
    await run(guarded.optihashi_decompose); // first - runs
    const second = await run(guarded.optihashi_decompose); // repeat - blocked
    expect(second).toBe(DECOMPOSE_ALREADY_DONE_MSG);
    expect(calls).toHaveLength(1); // real decompose ran only once
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('returns the map unchanged when there is no optihashi_decompose (non-opti run)', () => {
    const other = {
      name: 'web_search',
      implementation: () => ({ toolFn: async () => 'ok', toolSchema: {} }),
    } as unknown as ToolDefinition;
    const map = { web_search: other };
    const guarded = guardDecomposeOnce(map, { decomposeUsed: false });
    expect(guarded).toBe(map);
  });

  it('does not mutate the input map', () => {
    const { tool } = fakeDecompose();
    const map = { optihashi_decompose: tool };
    const guarded = guardDecomposeOnce(map, { decomposeUsed: false });
    expect(guarded).not.toBe(map);
    expect(map.optihashi_decompose).toBe(tool); // original entry untouched
  });

  // #680 regression: with the flag now DURABLE, a failed first decompose must not latch it -- else
  // it would permanently block retries across continuations against a plan that never loaded.
  it('does NOT latch the flag when decompose returns an Error string; a retry re-runs it', async () => {
    const calls: unknown[] = [];
    const tool = {
      name: 'optihashi_decompose',
      implementation: () => ({
        toolFn: async (p?: unknown) => {
          calls.push(p);
          return calls.length === 1 ? 'Error: could not formulate step 1' : 'PLAN CREATED';
        },
        toolSchema: {},
      }),
    } as unknown as ToolDefinition;
    const state = { decomposeUsed: false };
    const guarded = guardDecomposeOnce({ optihashi_decompose: tool }, state);

    const first = await run(guarded.optihashi_decompose);
    expect(first).toMatch(/^Error:/);
    expect(state.decomposeUsed).toBe(false); // failure did not latch

    const second = await run(guarded.optihashi_decompose);
    expect(second).toBe('PLAN CREATED'); // retry actually re-ran the real tool
    expect(calls).toHaveLength(2);
    expect(state.decomposeUsed).toBe(true); // success latches
  });

  it('does NOT latch the flag when decompose throws (error surfaces, retry still allowed)', async () => {
    let attempts = 0;
    const tool = {
      name: 'optihashi_decompose',
      implementation: () => ({
        toolFn: async () => {
          attempts++;
          if (attempts === 1) throw new Error('boom');
          return 'PLAN CREATED';
        },
        toolSchema: {},
      }),
    } as unknown as ToolDefinition;
    const state = { decomposeUsed: false };
    const guarded = guardDecomposeOnce({ optihashi_decompose: tool }, state);

    await expect(run(guarded.optihashi_decompose)).rejects.toThrow('boom');
    expect(state.decomposeUsed).toBe(false); // throw did not latch
    expect(await run(guarded.optihashi_decompose)).toBe('PLAN CREATED'); // retry runs
  });
});
