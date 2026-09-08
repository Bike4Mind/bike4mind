import { describe, expect, it } from 'vitest';
import {
  DATA_LAKE_STABLE_STATUSES,
  DATA_LAKE_STATUSES,
  DATA_LAKE_TRANSITIONAL_STATUSES,
  TRANSITIONAL_RETRY_ACTION,
  retryActionFor,
  type DataLakeStatus,
} from './DataLakeTypes';

describe('data lake status partition', () => {
  it('derives exactly the transitional statuses', () => {
    expect([...DATA_LAKE_TRANSITIONAL_STATUSES].sort()).toEqual(
      ['archiving', 'deleting', 'purging', 'restoring', 'unarchiving'].sort()
    );
  });

  it('shares no member with the stable set', () => {
    const stable = new Set<DataLakeStatus>(DATA_LAKE_STABLE_STATUSES);
    expect(DATA_LAKE_TRANSITIONAL_STATUSES.filter(s => stable.has(s))).toEqual([]);
  });

  // The partition is what makes the needs-attention list exhaustive: a status in neither set would
  // be a lake that renders in no list at all, which is the bug this surface exists to close.
  it('partitions every declared status', () => {
    expect([...DATA_LAKE_STABLE_STATUSES, ...DATA_LAKE_TRANSITIONAL_STATUSES].sort()).toEqual(
      [...DATA_LAKE_STATUSES].sort()
    );
  });
});

describe('TRANSITIONAL_RETRY_ACTION', () => {
  it('maps every transitional status except purging', () => {
    const retryable = DATA_LAKE_TRANSITIONAL_STATUSES.filter(s => s in TRANSITIONAL_RETRY_ACTION);
    expect(retryable.sort()).toEqual(['archiving', 'deleting', 'restoring', 'unarchiving']);
    expect('purging' in TRANSITIONAL_RETRY_ACTION).toBe(false);
  });

  // Each mapped action must be the one whose service re-admits that very status for crash
  // re-entry (see archiveDataLake/unarchiveDataLake/restoreDeletedDataLake/deleteDataLake) -
  // mapping a status onto any other action would hit that service's refusal guard instead.
  it('maps each status to the action whose service re-admits it', () => {
    expect(TRANSITIONAL_RETRY_ACTION).toEqual({
      archiving: 'archive',
      unarchiving: 'unarchive',
      restoring: 'restore',
      deleting: 'delete',
    });
  });

  it('names only actions the lifecycle route accepts', () => {
    const routeActions = ['archive', 'unarchive', 'restore', 'delete', 'cleanup'];
    for (const action of Object.values(TRANSITIONAL_RETRY_ACTION)) {
      expect(routeActions).toContain(action);
    }
  });
});

describe('retryActionFor', () => {
  it('answers for every retryable transitional status', () => {
    expect(retryActionFor('archiving')).toBe('archive');
    expect(retryActionFor('unarchiving')).toBe('unarchive');
    expect(retryActionFor('restoring')).toBe('restore');
    expect(retryActionFor('deleting')).toBe('delete');
  });

  // Undefined is the signal the UI reads to withhold Retry entirely - a purge is already accepted
  // and its sweep irreversible, so offering a retry would be a lie.
  it('has no answer for purging', () => {
    expect(retryActionFor('purging')).toBeUndefined();
  });

  it('has no answer for a stable status', () => {
    for (const status of DATA_LAKE_STABLE_STATUSES) {
      expect(retryActionFor(status)).toBeUndefined();
    }
  });
});
