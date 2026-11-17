import { describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import {
  SecopsTriageRunModel,
  secopsTriageRunRepository as repository,
  type RecordSecopsTriageRunInput,
} from './SecopsTriageRunModel';

const BASE = new Date('2026-11-17T10:00:00Z');
const MINUTE_MS = 60 * 1000;

const input = (over: Partial<RecordSecopsTriageRunInput> = {}): RecordSecopsTriageRunInput => ({
  stage: 'dev',
  scanSource: 'web-owasp',
  status: 'completed',
  dryRun: false,
  findingCount: 3,
  startedAt: BASE,
  ...over,
});

describe('SecopsTriageRunRepository', () => {
  setupMongoTest();

  it('records a completed run with its counts and returns it without empty optional fields', async () => {
    const counts = { created: 1, updated: 0, reopened: 1, closed: 0, suppressed: 1, belowThreshold: 0, overCap: 0 };

    const row = await repository.record(input({ counts, durationMs: 1234 }));

    expect(row).toEqual({
      id: expect.any(String),
      stage: 'dev',
      scanSource: 'web-owasp',
      status: 'completed',
      dryRun: false,
      findingCount: 3,
      counts,
      startedAt: BASE,
      durationMs: 1234,
    });
  });

  it('records a skipped run with its reason and truncates a long error to 500 characters', async () => {
    const skipped = await repository.record(input({ status: 'skipped', reason: 'not_allowed', findingCount: 0 }));
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'not_allowed' });
    expect(skipped).not.toHaveProperty('counts');

    const failed = await repository.record(input({ status: 'failed', error: 'x'.repeat(800) }));
    expect(failed.error).toHaveLength(500);
    const stored = await SecopsTriageRunModel.findById(failed.id).lean();
    expect(stored?.error).toHaveLength(500);
  });

  it('rejects a status outside completed, failed and skipped', async () => {
    await expect(repository.record(input({ status: 'unknown' as never }))).rejects.toThrow(/status/);
  });

  it('returns the stage runs newest first, capped at the limit, and leaves other stages out', async () => {
    for (let i = 0; i < 12; i++) {
      await repository.record(input({ startedAt: new Date(BASE.getTime() + i * MINUTE_MS), findingCount: i }));
    }
    await repository.record(input({ stage: 'prod', startedAt: new Date(BASE.getTime() + 60 * MINUTE_MS) }));

    const recent = await repository.findRecentByStage('dev');
    expect(recent.map(run => run.findingCount)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(recent.every(run => run.stage === 'dev')).toBe(true);

    const latestTwo = await repository.findRecentByStage('dev', 2);
    expect(latestTwo.map(run => run.findingCount)).toEqual([11, 10]);

    expect(await repository.findRecentByStage('staging')).toEqual([]);
  });

  it('declares the stage lookup index and a 90-day TTL on startedAt', () => {
    const indexes = SecopsTriageRunModel.schema.indexes();
    expect(indexes).toContainEqual([{ stage: 1, startedAt: -1 }, expect.anything()]);
    expect(indexes).toContainEqual([{ startedAt: 1 }, expect.objectContaining({ expireAfterSeconds: 90 * 86400 })]);
  });
});
