import { describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import { SecurityScanSchedule, securityScanScheduleRepository } from './SecurityScanScheduleModel';

const NOW = new Date('2026-11-02T12:00:00Z');
const PAST = new Date('2026-11-02T02:00:00Z');

// Inserted through the collection so a scan type the schema no longer allows can still be seeded.
const insertDue = (stage: string, scanType: string) =>
  SecurityScanSchedule.collection.insertOne({
    stage,
    scanType,
    enabled: true,
    dayOfWeek: 0,
    timeOfDay: '02:00',
    nextRunAt: PAST,
    createdBy: 'admin-user',
    createdAt: PAST,
    updatedAt: PAST,
  });

describe('SecurityScanScheduleRepository.findDueScans', () => {
  setupMongoTest();

  it('returns only due schedules of a scan type that is still supported', async () => {
    await insertDue('dev', 'web');
    await insertDue('dev', 'waf');
    await insertDue('dev', 'code');

    const due = await securityScanScheduleRepository.findDueScans(NOW);

    expect(due.map(schedule => schedule.scanType)).toEqual(['web']);
  });
});
