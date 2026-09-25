import { describe, it, expect } from 'vitest';
import { resolveAggregateToolModel, settleToolCallCredits, UNATTRIBUTED_TOOL_CHARGE } from './settleToolCredits';

const sum = (fcs: { creditsUsed?: number }[]) => fcs.reduce((acc, fc) => acc + (fc.creditsUsed ?? 0), 0);

describe('settleToolCallCredits', () => {
  it('stamps a single call with its reserved charge', () => {
    const calls = [{ name: 'music_generation' }];
    const settled = settleToolCallCredits(calls, new Map([['music_generation', [120]]]));
    expect(settled).toEqual([{ name: 'music_generation', creditsUsed: 120 }]);
  });

  it('settles two music_generation calls as the sum of both, not 2x the later cost', () => {
    // The bug this locks: a name-keyed single value stamped both calls with 200 -> 400.
    const calls = [{ name: 'music_generation' }, { name: 'music_generation' }];
    const settled = settleToolCallCredits(calls, new Map([['music_generation', [100, 200]]]));
    expect(settled.map(fc => fc.creditsUsed)).toEqual([100, 200]);
    expect(sum(settled)).toBe(300);
  });

  it('keeps each tool independent when several tools fire in one turn', () => {
    const calls = [{ name: 'image_generation' }, { name: 'music_generation' }, { name: 'music_generation' }];
    const map = new Map([
      ['image_generation', [400]],
      ['music_generation', [100, 250]],
    ]);
    expect(settleToolCallCredits(calls, map).map(fc => fc.creditsUsed)).toEqual([400, 100, 250]);
  });

  it('bills only the delivered call when an earlier same-tool call reserved nothing', () => {
    // A failed music_generation returns before onFinish, so only one charge is queued
    // for two calls. Attribution shifts to the first entry, but the total is unchanged.
    const calls = [{ name: 'music_generation' }, { name: 'music_generation' }];
    const settled = settleToolCallCredits(calls, new Map([['music_generation', [180]]]));
    expect(sum(settled)).toBe(180);
  });

  it('leaves calls with no reservation untouched', () => {
    const calls = [{ name: 'web_search' }, { name: 'music_generation', creditsUsed: 7 }];
    const settled = settleToolCallCredits(calls, new Map());
    expect(settled).toEqual([{ name: 'web_search' }, { name: 'music_generation', creditsUsed: 7 }]);
  });

  it('does not mutate the shared credits map', () => {
    const map = new Map([['music_generation', [100, 200]]]);
    settleToolCallCredits([{ name: 'music_generation' }, { name: 'music_generation' }], map);
    expect(map.get('music_generation')).toEqual([100, 200]);
  });
});

describe('resolveAggregateToolModel', () => {
  // The bug this locks: the aggregate row carried the quest's CHAT model, so an image
  // billed to gpt-image-2 rendered as global.anthropic.claude-sonnet-5.
  it('names the single model that actually charged', () => {
    expect(resolveAggregateToolModel(new Set(['gpt-image-2']))).toBe('gpt-image-2');
  });

  it('collapses repeat calls on one model to that model', () => {
    expect(resolveAggregateToolModel(['gpt-image-2', 'gpt-image-2'])).toBe('gpt-image-2');
  });

  it('names nothing rather than one of several models', () => {
    expect(resolveAggregateToolModel(new Set(['gpt-image-2', 'flux-pro-1.1']))).toBeUndefined();
  });

  it('names nothing when no charging model was resolvable', () => {
    expect(resolveAggregateToolModel(new Set())).toBeUndefined();
  });

  // A delegate_to_agent whose subagent model is absent from availableModels still charges
  // (delegateToAgent drops the usage event but fires onCredits anyway). Without the
  // sentinel the set below would hold one entry and the row would be stamped gpt-image-2
  // while its credits also cover the delegation - authoritative and wrong.
  it('names nothing when an unattributable charge rides alongside one known model', () => {
    expect(resolveAggregateToolModel(new Set(['gpt-image-2', UNATTRIBUTED_TOOL_CHARGE]))).toBeUndefined();
  });

  it('never leaks the sentinel into the ledger when it is the only charge', () => {
    expect(resolveAggregateToolModel(new Set([UNATTRIBUTED_TOOL_CHARGE]))).toBeUndefined();
  });
});
