import { describe, expect, it } from 'vitest';
import {
  DATA_LAKE_STABLE_STATUSES,
  DATA_LAKE_STATUSES,
  DATA_LAKE_TRANSITIONAL_STATUSES,
  LAKE_INGESTABLE_STATUSES,
  isLakeIngestable,
  TRANSITIONAL_RETRY_ACTION,
  resolveRetryAction,
  strandedCutoffMsFor,
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
  it('maps only the transitional statuses whose action the status alone determines', () => {
    const mapped = DATA_LAKE_TRANSITIONAL_STATUSES.filter(s => s in TRANSITIONAL_RETRY_ACTION);
    expect(mapped.sort()).toEqual(['archiving', 'deleting', 'unarchiving']);
  });

  // 'purging' has no retry (its sweep is accepted and irreversible); 'restoring' has no retry the
  // STATUS determines, because both axes admit it as a claim source - resolveRetryAction below.
  it('omits purging and restoring', () => {
    expect('purging' in TRANSITIONAL_RETRY_ACTION).toBe(false);
    expect('restoring' in TRANSITIONAL_RETRY_ACTION).toBe(false);
  });

  // Each mapped action must be the one whose service re-admits that very status for crash
  // re-entry (see archiveDataLake/unarchiveDataLake/deleteDataLake) - mapping a status onto any
  // other action would hit that service's refusal guard instead.
  it('maps each status to the action whose service re-admits it', () => {
    expect(TRANSITIONAL_RETRY_ACTION).toEqual({
      archiving: 'archive',
      unarchiving: 'unarchive',
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

describe('resolveRetryAction', () => {
  const lake = (status: DataLakeStatus, marks: { archived?: boolean; deleted?: boolean } = {}) => ({
    status,
    filesArchivedAt: marks.archived ? new Date('2020-01-01T00:00:00Z') : null,
    filesDeletedAt: marks.deleted ? new Date('2020-01-01T00:00:00Z') : null,
  });

  it('answers from the status alone where the status is axis-unique', () => {
    expect(resolveRetryAction(lake('archiving'))).toBe('archive');
    expect(resolveRetryAction(lake('unarchiving'))).toBe('unarchive');
    expect(resolveRetryAction(lake('deleting'))).toBe('delete');
  });

  // The two cases that must not collapse into one fixed answer. Sending an archive-axis lake
  // through the delete-axis restore clears its filesArchivedAt while matching none of its files
  // (that update is gated on deletedAt), stranding it beyond any UI path; the mirror holds.
  it('resolves a restoring lake by its own sweep mark, per axis', () => {
    expect(resolveRetryAction(lake('restoring', { archived: true }))).toBe('unarchive');
    expect(resolveRetryAction(lake('restoring', { deleted: true }))).toBe('restore');
  });

  // Both marks is the routine archive-then-delete lake, not an ambiguous one: a delete admits an
  // 'archived' source and clears neither mark, while nothing that settles to 'archived' can leave
  // filesDeletedAt behind. Reading filesArchivedAt first would answer 'unarchive' here and strand
  // it, so the ORDER is the assertion.
  it('resolves a restoring lake carrying both marks onto the delete axis', () => {
    expect(resolveRetryAction(lake('restoring', { archived: true, deleted: true }))).toBe('restore');
  });

  it('withholds a retry from a restoring lake whose axis is not provable', () => {
    expect(resolveRetryAction(lake('restoring'))).toBeUndefined();
  });

  it('reads a missing mark field the same as an unset one', () => {
    expect(resolveRetryAction({ status: 'restoring' })).toBeUndefined();
    expect(resolveRetryAction({ status: 'restoring', filesArchivedAt: new Date() })).toBe('unarchive');
  });

  // Undefined is the signal the UI reads to withhold Retry entirely - a purge is already accepted
  // and its sweep irreversible, so offering a retry would be a lie.
  it('has no answer for purging', () => {
    expect(resolveRetryAction(lake('purging'))).toBeUndefined();
  });

  it('has no answer for a stable status', () => {
    for (const status of DATA_LAKE_STABLE_STATUSES) {
      expect(resolveRetryAction(lake(status))).toBeUndefined();
    }
  });
});

describe('strandedCutoffMsFor', () => {
  // The four inline statuses share the request Lambda's 60-second ceiling, so one number is right
  // for all of them; `purging` sweeps on a queue consumer and must not be judged by that clock.
  it('gives every inline status the same cutoff and purging a longer one', () => {
    const inline = DATA_LAKE_TRANSITIONAL_STATUSES.filter(s => s !== 'purging');
    const cutoffs = new Set(inline.map(strandedCutoffMsFor));
    expect(cutoffs.size).toBe(1);
    expect(strandedCutoffMsFor('purging')).toBeGreaterThan([...cutoffs][0]);
  });

  // Past the consumer's own budget: a 12-minute visibility timeout x 3 attempts (infra/queues.ts).
  // A cutoff inside that window would flag a purge SQS is still legitimately retrying.
  it('puts the purging cutoff past the cleanup consumer retry budget', () => {
    expect(strandedCutoffMsFor('purging')).toBeGreaterThanOrEqual(36 * 60_000);
  });
});

describe('isLakeIngestable', () => {
  // Derived over the whole enum rather than spot-checked, so a tenth status cannot land uncovered:
  // adding one to DATA_LAKE_STATUSES without deciding here fails this test instead of silently
  // defaulting to "refused" at six ingest doors.
  it.each(DATA_LAKE_STATUSES)('%s is ingestable only if it is draft or active', status => {
    expect(isLakeIngestable(status)).toBe(status === 'draft' || status === 'active');
  });

  it('refuses a lake with no status', () => {
    expect(isLakeIngestable(undefined)).toBe(false);
  });

  it('lists exactly the two writable statuses', () => {
    expect([...LAKE_INGESTABLE_STATUSES]).toEqual(['draft', 'active']);
  });
});
