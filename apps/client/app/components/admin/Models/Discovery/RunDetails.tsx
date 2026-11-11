import type { ReactNode } from 'react';
import { ADAPTER_LITERAL_PRICE_SOURCE } from '@bike4mind/common';
import { Box, Stack, Typography } from '@mui/joy';
import { DataTable, Fact, SectionCard, StatusChip, type DataColumn } from '../../shared';
import type { DiscoveryRun, RunCatalogDiffEntry, RunLifecycleTransition, RunPriceRow } from './discoveryApi';
import {
  blockerCopy,
  countLabel,
  flagCopy,
  formatRunTime,
  inOut,
  longContextBrackets,
  modeLabel,
  priceSkipCopy,
  runResult,
  signalCopy,
  sourceSkipCopy,
  triggerLabel,
  usdPerMTok,
} from './discoveryCopy';

/** Undefined is tolerated: a subdocument written before its path existed has no array. */
const list = (values: readonly string[] | undefined) => (values && values.length > 0 ? values.join(', ') : '-');

const BUILD_TABLE = 'Build table';

const Mono = ({ children }: { children: ReactNode }) => (
  <Typography level="body-xs" fontFamily="code" sx={{ color: 'admin.ink', overflowWrap: 'anywhere' }}>
    {children}
  </Typography>
);

/** A code beside its plain words; the only place on the run page a code is shown. */
const Coded = ({ code, text }: { code: string; text: string }) => (
  <Stack>
    <Typography level="body-sm">{text}</Typography>
    <Mono>{code}</Mono>
  </Stack>
);

function DetailCard<Row>({
  title,
  rows,
  columns,
  getRowId,
  testId,
  rowTestId,
}: {
  title: string;
  rows: readonly Row[];
  columns: readonly DataColumn<Row>[];
  getRowId: (row: Row) => string;
  testId: string;
  rowTestId?: (row: Row) => string;
}) {
  return (
    <SectionCard title={title} body="custom" data-testid={`${testId}-card`}>
      <Box sx={{ p: 2 }}>
        <DataTable
          label={title}
          testId={testId}
          rows={rows}
          columns={columns}
          getRowId={getRowId}
          rowTestId={rowTestId}
          onRetry={() => undefined}
          pagination={rows.length > 25 ? undefined : false}
        />
      </Box>
    </SectionCard>
  );
}

type SourceRow = {
  key: string;
  name: string;
  outcome: 'ok' | 'failed' | 'skipped';
  durationMs?: number;
  httpStatus?: number;
  recordCount?: number;
  detail?: ReactNode;
};

// A skipped source is not a failed one; showing it as bad is the misreading this table exists to remove.
const OUTCOME_TONE = { ok: 'good', failed: 'bad', skipped: 'neutral' } as const;

const SOURCE_COLUMNS: DataColumn<SourceRow>[] = [
  { id: 'name', label: 'Source', render: row => row.name },
  {
    id: 'outcome',
    label: 'Outcome',
    width: '7rem',
    render: row => <StatusChip tone={OUTCOME_TONE[row.outcome]} label={row.outcome} />,
  },
  { id: 'ms', label: 'Time (ms)', numeric: true, width: '7rem', render: row => row.durationMs ?? '-' },
  { id: 'http', label: 'HTTP', numeric: true, width: '5rem', render: row => row.httpStatus ?? '-' },
  { id: 'records', label: 'Records', numeric: true, width: '6rem', render: row => row.recordCount ?? '-' },
  { id: 'detail', label: 'Detail', render: row => row.detail ?? '-' },
];

const priceRowColumns: DataColumn<RunPriceRow & { index: number }>[] = [
  { id: 'model', label: 'Model', render: row => <Mono>{row.modelId}</Mono> },
  { id: 'input', label: 'Input per 1M', numeric: true, render: row => usdPerMTok(row.inputPerMTok) },
  { id: 'output', label: 'Output per 1M', numeric: true, render: row => usdPerMTok(row.outputPerMTok) },
  {
    id: 'from',
    label: 'From',
    render: row => list(row.sources.map(source => (source === ADAPTER_LITERAL_PRICE_SOURCE ? BUILD_TABLE : source))),
  },
  { id: 'note', label: 'Note', render: row => row.note || '-' },
];

const lifecycleColumns: DataColumn<RunLifecycleTransition & { index: number }>[] = [
  { id: 'model', label: 'Model', render: row => <Mono>{row.modelId}</Mono> },
  { id: 'change', label: 'Change', render: row => `${row.from ?? 'none'} -> ${row.to}` },
  { id: 'signal', label: 'Signal', render: row => <Coded code={row.signal} text={signalCopy(row.signal)} /> },
  { id: 'deprecation', label: 'Deprecation', render: row => row.deprecationDate ?? '-' },
  { id: 'retirement', label: 'Retirement', render: row => row.retirementDate ?? '-' },
  { id: 'successor', label: 'Successor', render: row => (row.replacedBy ? <Mono>{row.replacedBy}</Mono> : '-') },
  { id: 'applied', label: 'Applied', render: row => (row.autoApplied ? 'auto-applied' : 'suggestion') },
];

const catalogColumns: DataColumn<RunCatalogDiffEntry>[] = [
  { id: 'model', label: 'Model', render: row => <Mono>{row.modelId}</Mono> },
  { id: 'kind', label: 'Kind', width: '6rem', render: row => row.kind },
  { id: 'keys', label: 'Changed keys', render: row => list(row.changedKeys) },
  { id: 'lifecycle', label: 'Lifecycle', width: '7rem', render: row => row.lifecycleStatus },
  { id: 'promoted', label: 'Listed', width: '5rem', render: row => (row.promoted ? 'yes' : 'no') },
  {
    id: 'blocked',
    label: 'Blocked by',
    width: '16rem',
    render: row =>
      row.blockedBy.length > 0 ? (
        <Stack gap={0.5}>
          {row.blockedBy.map(code => (
            <Coded key={code} code={code} text={blockerCopy(code)} />
          ))}
        </Stack>
      ) : (
        '-'
      ),
  },
  { id: 'owned', label: 'Set by admin', width: '7rem', render: row => (row.operatorOwned ? 'yes' : 'no') },
];

/**
 * Everything a run recorded, below the plain-language sections: sources and coverage, counters, every capped
 * detail array, unmatched ids, dropped records and frozen Bedrock profiles. Codes appear only here.
 */
export function RunDetails({ run }: { run: DiscoveryRun }) {
  const totals = run.detailTotals ?? {};
  const result = runResult(run);
  const overrides = run.priceOverrides ?? [];
  const longContextGaps = run.longContextGaps ?? [];
  const sourceRows: SourceRow[] = [
    ...run.sources.map(source => ({
      key: `attempted:${source.name}`,
      name: source.name,
      outcome: (source.ok ? 'ok' : 'failed') as SourceRow['outcome'],
      durationMs: source.durationMs,
      httpStatus: source.httpStatus,
      recordCount: source.recordCount,
      detail: source.error,
    })),
    ...(run.skippedSources ?? []).map(skipped => ({
      key: `skipped:${skipped.name}`,
      name: skipped.name,
      outcome: 'skipped' as const,
      detail: <Coded code={skipped.reason} text={sourceSkipCopy(skipped.reason)} />,
    })),
  ];
  // The run document caps its price rows; the total says how many it had.
  const priceRowsTitle =
    totals.priceRows !== undefined && totals.priceRows > run.priceRows.length
      ? `Price rows (${run.priceRows.length} shown, ${totals.priceRows} in the run)`
      : `Price rows (${run.priceRows.length})`;

  return (
    <Stack gap={2} data-testid="discovery-run-details">
      <SectionCard title="Run" data-testid="discovery-run-facts">
        <Fact label="Run id">
          <Mono>{run.id}</Mono>
        </Fact>
        <Fact label="Result" data-testid="discovery-run-fact-result">
          {`${result.label} (${run.status})`}
        </Fact>
        <Fact label="Trigger">{`${triggerLabel(run.trigger)} (${run.trigger})`}</Fact>
        <Fact label="Host">{run.host}</Fact>
        <Fact label="Mode" data-testid="discovery-run-fact-mode">
          {run.mode ? `${modeLabel(run.mode)} (${run.mode})` : modeLabel(run.mode)}
        </Fact>
        <Fact label="Started">{formatRunTime(run.startedAt)}</Fact>
        <Fact label="Finished">{run.finishedAt ? formatRunTime(run.finishedAt) : 'Still running'}</Fact>
        <Fact label="Passes" data-testid="discovery-run-passes">
          {String(run.passes)}
        </Fact>
        <Fact label="Catalog rows" data-testid="discovery-run-catalog-counter">
          {`${run.changes.appendedRows} of ${run.changes.plannedRows} planned appended`}
        </Fact>
        <Fact label="Price rows" data-testid="discovery-run-price-counter">
          {`${run.changes.appendedPriceRows} of ${run.changes.plannedPriceRows} planned appended`}
        </Fact>
        <Fact label="Aggregator coverage" data-testid="discovery-run-coverage">
          {run.joinCoverage.length > 0
            ? run.joinCoverage
                .map(coverage => `${coverage.aggregator} ${coverage.matched} of ${coverage.total} matched`)
                .join(', ')
            : undefined}
        </Fact>
        <Fact label="Unmatched by every aggregator" data-testid="discovery-run-unmatched">
          {run.unmatchedIds.length > 0 ? <Mono>{list(run.unmatchedIds)}</Mono> : undefined}
        </Fact>
        <Fact label="Bedrock profiles frozen, foundation id not listed" data-testid="discovery-run-frozen-profiles">
          {run.frozenProfileIds.length > 0 ? <Mono>{list(run.frozenProfileIds)}</Mono> : undefined}
        </Fact>
        <Fact label="Set by admin, planned changes not applied" data-testid="discovery-run-operator-conflicts">
          {run.changes.operatorConflicts.length > 0 ? <Mono>{list(run.changes.operatorConflicts)}</Mono> : undefined}
        </Fact>
      </SectionCard>

      {sourceRows.length > 0 && (
        <DetailCard
          title={`Sources (${sourceRows.length})`}
          rows={sourceRows}
          columns={SOURCE_COLUMNS}
          getRowId={row => row.key}
          testId="discovery-run-sources-table"
          rowTestId={row =>
            row.outcome === 'skipped' ? `discovery-run-skipped-row-${row.name}` : `discovery-run-source-row-${row.name}`
          }
        />
      )}

      {run.priceFlags.length > 0 && (
        <DetailCard
          title={`Price flags (${countLabel(run.priceFlags.length, totals.priceFlags)})`}
          rows={run.priceFlags}
          columns={[
            { id: 'model', label: 'Model', render: flag => <Mono>{flag.modelId}</Mono> },
            {
              id: 'kind',
              label: 'Kind',
              width: '14rem',
              render: flag => <Coded code={flag.kind} text={flagCopy(flag.kind, flag.detail)} />,
            },
            { id: 'proposed', label: 'Proposed per 1M', render: flag => inOut(flag.proposed) },
            { id: 'current', label: 'In force per 1M', render: flag => inOut(flag.current) },
            { id: 'sources', label: 'Sources', render: flag => list(flag.sources) },
            { id: 'detail', label: 'Why', width: '18rem', render: flag => flag.detail },
          ]}
          getRowId={flag => `${flag.modelId}|${flag.kind}`}
          testId="discovery-run-price-flags-table"
          rowTestId={flag => `discovery-run-flag-row-${flag.modelId}`}
        />
      )}

      {run.priceRows.length > 0 && (
        // Indexed: price rows are flatMapped across convergence passes, so one model and unit twice is legitimate.
        <DetailCard
          title={priceRowsTitle}
          rows={run.priceRows.map((row, index) => ({ ...row, index }))}
          columns={priceRowColumns}
          getRowId={row => `${row.modelId}|${row.unit}|${row.index}`}
          testId="discovery-run-price-rows-table"
          rowTestId={row => `discovery-run-price-row-${row.modelId}-${row.index}`}
        />
      )}

      {overrides.length > 0 && (
        <DetailCard
          title={`Overruled a disagreeing source (${countLabel(overrides.length, totals.priceOverrides)})`}
          rows={overrides}
          columns={[
            { id: 'model', label: 'Model', render: override => <Mono>{override.modelId}</Mono> },
            { id: 'rate', label: 'Rate per 1M', render: override => inOut(override.applied) },
            { id: 'source', label: 'From', render: override => override.source },
            { id: 'dissenting', label: 'Overruled', render: override => list(override.dissenting) },
            { id: 'detail', label: 'Why', width: '18rem', render: override => override.detail },
          ]}
          getRowId={override => override.modelId}
          testId="discovery-run-price-overrides-table"
          rowTestId={override => `discovery-run-price-override-row-${override.modelId}`}
        />
      )}

      {/* Apart from the price flags: these rows were written or left standing, and are not refusals. */}
      {longContextGaps.length > 0 && (
        <DetailCard
          title={`Long-context rates not stored (${countLabel(longContextGaps.length, totals.longContextGaps)})`}
          rows={longContextGaps}
          columns={[
            { id: 'model', label: 'Model', render: gap => <Mono>{gap.modelId}</Mono> },
            { id: 'flat', label: 'Flat per 1M', render: gap => inOut(gap.base) },
            { id: 'published', label: 'Published', render: gap => longContextBrackets(gap.brackets) },
            { id: 'source', label: 'Source', render: gap => gap.source },
            { id: 'detail', label: 'Why', width: '18rem', render: gap => gap.detail },
          ]}
          getRowId={gap => gap.modelId}
          testId="discovery-run-long-context-gaps-table"
          rowTestId={gap => `discovery-run-long-context-gap-row-${gap.modelId}`}
        />
      )}

      {run.lifecycleTransitions.length > 0 && (
        <DetailCard
          title={`Lifecycle transitions (${countLabel(run.lifecycleTransitions.length, totals.lifecycleTransitions)})`}
          rows={run.lifecycleTransitions.map((transition, index) => ({ ...transition, index }))}
          columns={lifecycleColumns}
          getRowId={row => `${row.modelId}|${row.index}`}
          testId="discovery-run-lifecycle-table"
          rowTestId={row => `discovery-run-lifecycle-row-${row.modelId}-${row.index}`}
        />
      )}

      {run.catalogDiff.length > 0 && (
        <DetailCard
          title={`Catalog changes (${countLabel(run.catalogDiff.length, totals.catalogDiff)})`}
          rows={run.catalogDiff}
          columns={catalogColumns}
          getRowId={entry => entry.modelId}
          testId="discovery-run-catalog-table"
          rowTestId={entry => `discovery-run-catalog-row-${entry.modelId}`}
        />
      )}

      {run.priceSkips.length > 0 && (
        <DetailCard
          title={`Not repriced (${countLabel(run.priceSkips.length, totals.priceSkips)})`}
          rows={run.priceSkips}
          columns={[
            { id: 'model', label: 'Model', render: skip => <Mono>{skip.modelId}</Mono> },
            {
              id: 'reason',
              label: 'Reason',
              render: skip => <Coded code={skip.reason} text={priceSkipCopy(skip.reason)} />,
            },
          ]}
          getRowId={skip => `${skip.modelId}|${skip.reason}`}
          testId="discovery-run-skips-table"
        />
      )}

      {run.droppedRecords.length > 0 && (
        <DetailCard
          title={`Dropped records (${run.droppedRecords.length})`}
          rows={run.droppedRecords}
          columns={[
            { id: 'model', label: 'Record', render: dropped => <Mono>{dropped.modelId}</Mono> },
            { id: 'source', label: 'Source', render: dropped => dropped.source },
            { id: 'reason', label: 'Reason', render: dropped => dropped.reason },
          ]}
          getRowId={dropped => `${dropped.source}|${dropped.modelId}|${dropped.reason}`}
          testId="discovery-run-dropped-table"
        />
      )}
    </Stack>
  );
}
