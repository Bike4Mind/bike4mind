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
// The ledger the guard shares with planCompletionGuard: `steps` is populated by the latter when a
// decompose result parses into a plan. Start empty, like a fresh execution.
const ledger = () => ({ decomposeUsed: false, steps: [] as unknown[] });

describe('guardDecomposeOnce', () => {
  it('runs the real decompose on the FIRST call', async () => {
    const { tool, calls } = fakeDecompose();
    const state = ledger();
    const guarded = guardDecomposeOnce({ optihashi_decompose: tool }, state);
    const out = await run(guarded.optihashi_decompose, { scenario: 'x' });
    expect(out).toBe('PLAN CREATED');
    expect(calls).toHaveLength(1);
    expect(state.decomposeUsed).toBe(true);
  });

  it('blocks a repeat ONLY once a plan has loaded (steps captured)', async () => {
    const { tool, calls } = fakeDecompose();
    const state = ledger();
    const onBlocked = vi.fn();
    const guarded = guardDecomposeOnce({ optihashi_decompose: tool }, state, onBlocked);
    await run(guarded.optihashi_decompose); // first - runs, latches decomposeUsed
    state.steps = [{ family: 'scheduling', title: 's' }]; // planCompletionGuard captured a plan
    const second = await run(guarded.optihashi_decompose); // repeat - now blocked
    expect(second).toBe(DECOMPOSE_ALREADY_DONE_MSG);
    expect(calls).toHaveLength(1); // real decompose ran only once
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  // #680 (F1): a first decompose that failed OR succeeded-but-unparseable latches decomposeUsed with
  // no captured plan. Gating the block on `decomposeUsed` alone would durably poison the run; gating
  // on a LOADED plan (steps>0) lets the agent re-decompose to recover.
  it('does NOT block a repeat when the flag latched but no plan loaded (steps empty)', async () => {
    const { tool, calls } = fakeDecompose();
    const state = { decomposeUsed: true, steps: [] as unknown[] }; // poisoned-looking state
    const onBlocked = vi.fn();
    const guarded = guardDecomposeOnce({ optihashi_decompose: tool }, state, onBlocked);
    const out = await run(guarded.optihashi_decompose);
    expect(out).toBe('PLAN CREATED'); // re-ran, not blocked
    expect(calls).toHaveLength(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('returns the map unchanged when there is no optihashi_decompose (non-opti run)', () => {
    const other = {
      name: 'web_search',
      implementation: () => ({ toolFn: async () => 'ok', toolSchema: {} }),
    } as unknown as ToolDefinition;
    const map = { web_search: other };
    const guarded = guardDecomposeOnce(map, ledger());
    expect(guarded).toBe(map);
  });

  it('does not mutate the input map', () => {
    const { tool } = fakeDecompose();
    const map = { optihashi_decompose: tool };
    const guarded = guardDecomposeOnce(map, ledger());
    expect(guarded).not.toBe(map);
    expect(map.optihashi_decompose).toBe(tool); // original entry untouched
  });
});
