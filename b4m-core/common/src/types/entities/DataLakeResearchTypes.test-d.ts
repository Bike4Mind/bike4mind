import { describe, expectTypeOf, it } from 'vitest';
import type { ResearchDropBucket, ResearchRunTotals } from './DataLakeResearchTypes';

type NotBuckets = 'searchHits' | 'proposed' | 'autoAdmitted' | 'autoAdmitSkipped' | 'reviewedByRule';

describe('ResearchDropBucket', () => {
  it('is exactly the totals keys minus the non-buckets', () => {
    expectTypeOf<ResearchDropBucket>().toEqualTypeOf<Exclude<keyof ResearchRunTotals, NotBuckets>>();
  });
});
