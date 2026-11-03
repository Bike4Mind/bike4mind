import { describe, expect, it } from 'vitest';
import { cacheLine, contextLine, contextRingValue, contextTooltip, KEEP_ALIVE_FOREVER_MS } from './contextStatus';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

describe('contextRingValue', () => {
  it('fills by used over limit and colors by how close compaction is', () => {
    expect(contextRingValue(34_000, 262_000)).toEqual({ percent: 13, arc: 13, color: 'primary' });
    expect(contextRingValue(200_000, 250_000)).toMatchObject({ percent: 80, color: 'warning' });
    expect(contextRingValue(240_000, 250_000)).toMatchObject({ percent: 96, color: 'danger' });
  });

  it('keeps a sliver visible for a nearly empty context, and an empty ring when nothing is known', () => {
    expect(contextRingValue(100, 262_000)).toMatchObject({ percent: 0, arc: 4 });
    expect(contextRingValue(null, 262_000)).toEqual({ percent: null, arc: 0, color: 'neutral' });
    expect(contextRingValue(34_000, null)).toEqual({ percent: null, arc: 0, color: 'neutral' });
  });
});

describe('contextLine', () => {
  it('reads used / limit', () => {
    expect(contextLine(34_000, 262_000)).toBe('34k / 262k context (13%)');
    expect(contextLine(100, 262_000)).toBe('100 / 262k context (<1%)');
  });

  it('says what it knows when the limit or the count is missing', () => {
    expect(contextLine(34_000, null)).toBe('34k context used');
    expect(contextLine(null, 262_000)).toBe('Context not measured yet');
  });
});

describe('cacheLine', () => {
  it('counts a cloud prompt cache down, then calls it expired', () => {
    const status = { kind: 'cloud', expiresAt: NOW + 187_000 } as const;
    expect(cacheLine(status, NOW)).toBe('Prompt cache warm, expires in 3m 7s');
    expect(cacheLine(status, NOW + 180_000)).toBe('Prompt cache warm, expires in 7s');
    expect(cacheLine(status, NOW + 187_000)).toBe('Prompt cache expired');
  });

  it('says loaded rather than warm for a local model, with its keep-alive', () => {
    const loaded = (expiresAt: number | null) => ({ kind: 'local', state: { kind: 'loaded', expiresAt } }) as const;
    expect(cacheLine(loaded(NOW + 250_000), NOW)).toBe('Model loaded, unloads in 4m 10s');
    expect(cacheLine(loaded(null), NOW)).toBe('Model loaded');
    expect(cacheLine(loaded(NOW + KEEP_ALIVE_FOREVER_MS + 1), NOW)).toBe('Model loaded, no keep-alive limit');
    expect(cacheLine(loaded(NOW - 1), NOW)).toBe('Model not loaded');
    expect(cacheLine({ kind: 'local', state: { kind: 'unloaded' } }, NOW)).toBe('Model not loaded');
  });

  it('says nothing without a source', () => {
    expect(cacheLine(null, NOW)).toBeNull();
    expect(cacheLine({ kind: 'local', state: { kind: 'unsupported' } }, NOW)).toBeNull();
    expect(cacheLine({ kind: 'local', state: { kind: 'unknown' } }, NOW)).toBeNull();
  });
});

describe('contextTooltip', () => {
  it('puts the cache state on its own line, only when there is one', () => {
    expect(contextTooltip(34_000, 262_000, 'Model loaded')).toBe('34k / 262k context (13%)\nModel loaded');
    expect(contextTooltip(34_000, 262_000, null)).toBe('34k / 262k context (13%)');
  });
});
