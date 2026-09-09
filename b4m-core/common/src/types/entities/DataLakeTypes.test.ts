import { describe, it, expect } from 'vitest';
import { DATA_LAKE_STATUSES, LAKE_INGESTABLE_STATUSES, isLakeIngestable } from './DataLakeTypes';

describe('isLakeIngestable', () => {
  // Derived over the whole enum rather than spot-checked, so a tenth status cannot land uncovered:
  // adding one to DATA_LAKE_STATUSES without deciding here fails this test instead of silently
  // defaulting to "refused" at five ingest doors.
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
