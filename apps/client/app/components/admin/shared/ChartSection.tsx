import React, { useState, type ReactNode } from 'react';
import { Box, Button, Skeleton, Stack, Typography } from '@mui/joy';
import { adminFocus } from './adminStyles';
import { DataTable, type DataColumn } from './DataTable';
import { SectionCard } from './SectionCard';
import { CHART_HEIGHT } from './chartParts';

export type ChartSectionBody =
  | { kind: 'loading' }
  /** Empty, not enough history, or a failed read: shown where the chart would be, with no table toggle. */
  | { kind: 'notice'; content: ReactNode }
  | { kind: 'ready'; caption: string; chart: ReactNode; table: ReactNode; footnote?: ReactNode };

type ChartSectionProps = {
  title: string;
  /** Prefixes the section's test ids: `-skeleton`, `-caption`, `-table-toggle-btn`. */
  testId: string;
  body: ChartSectionBody;
  skeletonHeight?: number;
};

/**
 * A chart in a SectionCard with its one-line takeaway, a "View as table" fallback, and a chart-shaped
 * skeleton (docs/admin-subscriptions-spec.md 5.7).
 */
export function ChartSection({ title, testId, body, skeletonHeight = CHART_HEIGHT }: ChartSectionProps) {
  const [asTable, setAsTable] = useState(false);
  let content: ReactNode;
  if (body.kind === 'loading') {
    content = (
      <Box sx={{ p: 2 }} aria-busy="true">
        <Skeleton
          variant="rectangular"
          height={skeletonHeight}
          sx={{ borderRadius: '8px' }}
          data-testid={`${testId}-skeleton`}
        />
      </Box>
    );
  } else if (body.kind === 'notice') {
    content = body.content;
  } else {
    content = (
      <Stack gap={1.5} sx={{ p: 2 }}>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid={`${testId}-caption`}>
          {body.caption}
        </Typography>
        {asTable ? body.table : body.chart}
        {body.footnote}
      </Stack>
    );
  }
  return (
    <SectionCard
      title={title}
      body="custom"
      data-testid={testId}
      action={
        body.kind === 'ready' && (
          <Button
            size="sm"
            variant="plain"
            onClick={() => setAsTable(previous => !previous)}
            aria-pressed={asTable}
            data-testid={`${testId}-table-toggle-btn`}
            sx={adminFocus}
          >
            {asTable ? 'View as chart' : 'View as table'}
          </Button>
        )
      }
    >
      {content}
    </SectionCard>
  );
}

/** The "View as table" body for the plotted values. */
export function ChartDataTable<Row>({
  label,
  testId,
  rows,
  columns,
  getRowId,
}: {
  label: string;
  testId: string;
  rows: readonly Row[];
  columns: DataColumn<Row>[];
  getRowId: (row: Row) => string;
}) {
  return (
    <DataTable
      label={label}
      testId={testId}
      rows={[...rows]}
      columns={columns}
      getRowId={getRowId}
      onRetry={() => undefined}
      minWidth="24rem"
    />
  );
}
