import { describe, expect, it } from 'vitest';
import {
  emptyResearchRunTotals,
  isResearchRunInFlight,
  RESEARCH_DROP_REASONS,
  RESEARCH_RUN_STALE_AFTER_MS,
  type ResearchRunLevers,
} from './DataLakeResearchTypes';

const NOW = new Date('2026-03-01T12:00:00.000Z').getTime();
const agoMs = (ms: number) => new Date(NOW - ms);

/**
 * The parity this guards is with `DataLakeResearchRunRepository.countActiveByLake`, which decides
 * whether a POST is refused. A drift here re-opens the lockout the age bound exists to close: the
 * button stays disabled for a lake the server would accept a run for.
 */
describe('isResearchRunInFlight', () => {
  it('counts a fresh queued or running run as in flight', () => {
    expect(isResearchRunInFlight({ status: 'queued', createdAt: agoMs(60_000) }, { now: NOW })).toBe(true);
    expect(isResearchRunInFlight({ status: 'running', startedAt: agoMs(60_000) }, { now: NOW })).toBe(true);
  });

  it('never counts a settled run, however recent', () => {
    expect(isResearchRunInFlight({ status: 'completed', startedAt: agoMs(1_000) }, { now: NOW })).toBe(false);
    expect(isResearchRunInFlight({ status: 'failed', startedAt: agoMs(1_000) }, { now: NOW })).toBe(false);
  });

  // A hard-killed run: the catch never executed, so the row keeps `running` for good. Reading it as
  // in flight forever is the permanent lockout, so the bound is what releases the lake.
  it('releases a non-terminal run once it is past the stale bound', () => {
    const stale = agoMs(RESEARCH_RUN_STALE_AFTER_MS + 60_000);
    expect(isResearchRunInFlight({ status: 'running', startedAt: stale }, { now: NOW })).toBe(false);
    expect(isResearchRunInFlight({ status: 'queued', createdAt: stale }, { now: NOW })).toBe(false);
  });

  it('holds the guard right up to the bound, inclusive', () => {
    const edge = agoMs(RESEARCH_RUN_STALE_AFTER_MS);
    expect(isResearchRunInFlight({ status: 'running', startedAt: edge }, { now: NOW })).toBe(true);
    expect(
      isResearchRunInFlight({ status: 'running', startedAt: agoMs(RESEARCH_RUN_STALE_AFTER_MS + 1) }, { now: NOW })
    ).toBe(false);
  });

  // Each status reads its OWN timestamp, matching the server's two-armed $or. Reading the wrong one
  // would let a long-queued row that started a second ago look stale, or the reverse.
  it('reads startedAt for running and createdAt for queued', () => {
    const fresh = agoMs(60_000);
    const stale = agoMs(RESEARCH_RUN_STALE_AFTER_MS + 60_000);
    expect(isResearchRunInFlight({ status: 'running', startedAt: fresh, createdAt: stale }, { now: NOW })).toBe(true);
    expect(isResearchRunInFlight({ status: 'running', startedAt: stale, createdAt: fresh }, { now: NOW })).toBe(false);
    expect(isResearchRunInFlight({ status: 'queued', createdAt: fresh, startedAt: stale }, { now: NOW })).toBe(true);
  });

  // Runs arrive over the wire as JSON, so the timestamps are strings on the client and Dates on the
  // server. Both call sites share this predicate, so both spellings have to answer the same.
  it('accepts an ISO string as readily as a Date', () => {
    expect(isResearchRunInFlight({ status: 'running', startedAt: agoMs(60_000).toISOString() }, { now: NOW })).toBe(
      true
    );
  });

  // Mirrors the server query, which cannot match a missing or unparseable field.
  it('does not count a non-terminal run whose timestamp is missing or unusable', () => {
    expect(isResearchRunInFlight({ status: 'running', startedAt: null }, { now: NOW })).toBe(false);
    expect(isResearchRunInFlight({ status: 'running' }, { now: NOW })).toBe(false);
    expect(isResearchRunInFlight({ status: 'queued', createdAt: 'not a date' }, { now: NOW })).toBe(false);
  });
});

describe('RESEARCH_DROP_REASONS', () => {
  const NOT_BUCKETS = ['searchHits', 'proposed', 'autoAdmitted', 'autoAdmitSkipped', 'reviewedByRule'] as const;

  it('has an entry for every drop bucket and none for a total or sub-count', () => {
    const bucketKeys = Object.keys(emptyResearchRunTotals()).filter(
      key => !(NOT_BUCKETS as readonly string[]).includes(key)
    );
    expect(Object.keys(RESEARCH_DROP_REASONS).sort()).toEqual(bucketKeys.sort());
  });

  it('pairs a lever with a direction, and a null lever with none', () => {
    const leverKeys = (key: keyof ResearchRunLevers) => key;
    for (const entry of Object.values(RESEARCH_DROP_REASONS)) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.lever === null).toBe(entry.direction === null);
    }
    expect(RESEARCH_DROP_REASONS.belowRelevance).toMatchObject({
      lever: leverKeys('minRelevance'),
      direction: 'lower',
    });
  });
});
