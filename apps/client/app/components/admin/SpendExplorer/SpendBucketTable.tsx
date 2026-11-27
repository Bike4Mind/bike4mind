import { useMemo } from 'react';
import type { SpendBucketSize, SpendTimelineBucket } from '@bike4mind/common';
import { ChartDataTable, type DataColumn } from '../shared';
import { formatBucket, formatUsd } from './spendExplorerModel';

/** "View as table" fallback for a spend chart: one row per bucket. */
export function SpendBucketTable({
  testId,
  label,
  buckets,
  bucketSize,
}: {
  testId: string;
  label: string;
  buckets: SpendTimelineBucket[];
  bucketSize: SpendBucketSize;
}) {
  const columns: DataColumn<SpendTimelineBucket>[] = useMemo(
    () => [
      {
        id: 'bucket',
        label: bucketSize === 'hour' ? 'Hour (UTC)' : 'Day (UTC)',
        render: b => formatBucket(b.start, bucketSize),
      },
      {
        id: 'total',
        label: 'Cost (USD)',
        numeric: true,
        render: b => formatUsd(b.totalUsd),
        sortValue: b => b.totalUsd,
      },
      { id: 'baseline', label: 'Rolling median', numeric: true, render: b => formatUsd(b.baselineUsd) },
      { id: 'previous', label: 'Previous period', numeric: true, render: b => formatUsd(b.previousUsd) },
      { id: 'spike', label: 'Spike', render: b => (b.isSpike ? 'Yes' : '-') },
    ],
    [bucketSize]
  );
  return <ChartDataTable label={label} testId={testId} rows={buckets} columns={columns} getRowId={b => b.start} />;
}
