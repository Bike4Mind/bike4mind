import { describe, expect, it } from 'vitest';
import type { PrSummary } from '@shared/pullRequest';
import { applyPrSummaryEvents } from './prSummaries';

describe('applyPrSummaryEvents', () => {
  const start: ReadonlyMap<string, PrSummary> = new Map([['a', { number: 1, state: 'open' }]]);

  it('hands back the same map when nothing changed, so the list does not re-render', () => {
    expect(applyPrSummaryEvents(start, [{ sessionId: 'a', summary: { number: 1, state: 'open' } }])).toBe(start);
    expect(applyPrSummaryEvents(start, [{ sessionId: 'b', summary: null }])).toBe(start);
  });

  it('applies a change, a new PR and a removal without touching the original', () => {
    const next = applyPrSummaryEvents(start, [
      { sessionId: 'a', summary: { number: 1, state: 'merged' } },
      { sessionId: 'b', summary: { number: 2, state: 'draft' } },
      { sessionId: 'b', summary: null },
    ]);
    expect(next).not.toBe(start);
    expect([...next]).toEqual([['a', { number: 1, state: 'merged' }]]);
    expect(start.get('a')?.state).toBe('open');
  });
});
