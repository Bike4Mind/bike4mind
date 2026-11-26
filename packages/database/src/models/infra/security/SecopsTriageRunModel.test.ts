import { describe, expect, it, vi } from 'vitest';
import type { PipelineStage } from 'mongoose';
import { setupMongoTest } from '../../../__test__/utils';
import {
  SecopsTriageRunModel,
  SecopsTriageExecutionModel,
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

  describe('findLatestPerSourceByStage', () => {
    const at = (minutes: number) => new Date(BASE.getTime() + minutes * MINUTE_MS);

    it('returns the newest run of each scan source on the stage, newest first', async () => {
      await repository.record(input({ scanSource: 'web-owasp', startedAt: at(0), findingCount: 1 }));
      await repository.record(input({ scanSource: 'web-owasp', startedAt: at(5), findingCount: 2 }));
      await repository.record(
        input({ scanSource: 'cloud', status: 'skipped', reason: 'disabled', startedAt: at(3), findingCount: 0 })
      );
      await repository.record(input({ scanSource: 'cloud', startedAt: at(1), findingCount: 4 }));
      await repository.record(input({ scanSource: 'active-defense', startedAt: at(2), findingCount: 5 }));
      await repository.record(input({ stage: 'prod', scanSource: 'secrets', startedAt: at(9) }));

      const latest = await repository.findLatestPerSourceByStage('dev');

      expect(latest.map(run => [run.scanSource, run.findingCount])).toEqual([
        ['web-owasp', 2],
        ['cloud', 0],
        ['active-defense', 5],
      ]);
      expect(latest[1]).toEqual({
        id: expect.any(String),
        stage: 'dev',
        scanSource: 'cloud',
        status: 'skipped',
        reason: 'disabled',
        dryRun: false,
        findingCount: 0,
        startedAt: at(3),
      });
      expect(await repository.findLatestPerSourceByStage('staging')).toEqual([]);
    });

    it('reads through the stage and startedAt index', async () => {
      await SecopsTriageRunModel.createIndexes();
      await repository.record(input());
      const aggregate = vi.spyOn(SecopsTriageRunModel, 'aggregate');

      await repository.findLatestPerSourceByStage('dev');
      const pipeline = aggregate.mock.calls[0][0] as PipelineStage[];
      aggregate.mockRestore();

      const plan = JSON.stringify(await SecopsTriageRunModel.aggregate(pipeline).explain());
      expect(plan).toContain('stage_1_startedAt_-1');
      expect(plan).not.toContain('COLLSCAN');
    });
  });

  it('declares the stage lookup index and a 90-day TTL on startedAt', () => {
    const indexes = SecopsTriageRunModel.schema.indexes();
    expect(indexes).toContainEqual([{ stage: 1, startedAt: -1 }, expect.anything()]);
    expect(indexes).toContainEqual([{ startedAt: 1 }, expect.objectContaining({ expireAfterSeconds: 90 * 86400 })]);
  });
});

describe('SecOps durable execution gate', () => {
  setupMongoTest();
  const executionId = 'secops-execution-' + 'b'.repeat(64);

  it('allows exactly one concurrent claimant and reports a durable running gate', async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => repository.claimExecution(executionId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await repository.executionStatus(executionId)).toBe('running');
    expect(await SecopsTriageExecutionModel.countDocuments()).toBe(1);
  });

  it('keeps a completed gate after historical run records are deleted', async () => {
    expect(await repository.executionStatus(executionId)).toBeNull();
    await repository.claimExecution(executionId);
    await repository.completeExecution(executionId);
    await SecopsTriageRunModel.deleteMany({});
    expect(await repository.executionStatus(executionId)).toBe('completed');
    expect(await repository.claimExecution(executionId)).toBe(false);
    expect(SecopsTriageExecutionModel.schema.indexes().every(([, options]) => !('expireAfterSeconds' in options))).toBe(
      true
    );
  });

  it('rejects completion without an existing running claim and fails closed after a lost completion acknowledgment', async () => {
    await expect(repository.completeExecution(executionId)).rejects.toThrow('not persisted');
    await repository.claimExecution(executionId);
    await repository.completeExecution(executionId);
    await expect(repository.completeExecution(executionId)).rejects.toThrow('not persisted');
    expect(await repository.executionStatus(executionId)).toBe('completed');
  });

  it('rejects raw or malformed execution identities before reading or writing', async () => {
    await expect(repository.claimExecution('raw-message-id')).rejects.toThrow('Invalid');
    await expect(repository.executionStatus('raw-message-id')).rejects.toThrow('Invalid');
    await expect(repository.completeExecution('raw-message-id')).rejects.toThrow('Invalid');
    expect(await SecopsTriageExecutionModel.countDocuments()).toBe(0);
  });
});
