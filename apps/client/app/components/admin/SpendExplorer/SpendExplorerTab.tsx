import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Button, Checkbox, Input, Stack, Typography } from '@mui/joy';
import {
  SPEND_BASELINE_WINDOW,
  SPEND_SPIKE_MULTIPLE,
  type SpendAccountRow,
  type SpendSplitDimension,
  type SpendTimelineBucket,
} from '@bike4mind/common';
import { AdminPageHeader, ChartSection, ErrorState, SegmentedControl, StatStrip, StatTile } from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { AccountSpendPanel } from './AccountSpendPanel';
import { FeatureCostSection, type FeatureCostSelection } from './FeatureCostSection';
import { SpendBucketTable } from './SpendBucketTable';
import { SpendChart } from './SpendChart';
import { SpendDrillDown } from './SpendDrillDown';
import { SPLIT_OPTIONS } from './seriesLabels';
import {
  RANGE_PRESETS,
  bucketMs,
  buildSlackSummary,
  computeKpis,
  customRange,
  formatBucket,
  formatRange,
  formatShare,
  formatUsd,
  toDayInput,
  type SpendRange,
} from './spendExplorerModel';
import {
  SPEND_EXPLORER_SEARCH_KEYS as KEYS,
  readSpendExplorerSearch,
  type SpendExplorerSearch,
  type SpendExplorerSearchPatch,
} from './spendExplorerSearch';
import { useSpendAccounts, useSpendTimeline } from './useSpendExplorer';

const CHART_ID = 'spend-explorer-chart';
type PresetValue = `${(typeof RANGE_PRESETS)[number]}` | 'custom';
const PRESET_OPTIONS: ReadonlyArray<{ value: PresetValue; label: string }> = [
  ...RANGE_PRESETS.map(days => ({ value: `${days}` as PresetValue, label: `${days}d` })),
  { value: 'custom', label: 'Custom' },
];

type CopyState = 'idle' | 'copied' | 'error';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

/**
 * Admin Spend explorer: recorded AI provider cost (UsageEvent COGS) over a range,
 * split by one dimension, with spikes against a rolling median and a drill-down to
 * the accounts behind any bucket. Range, split and selected bucket live in the URL.
 */
export default function SpendExplorerTab() {
  const search = useSearch({ strict: false }) as SpendExplorerSearch;
  const navigate = useNavigate();
  const view = useMemo(() => readSpendExplorerSearch(search), [search]);
  const [customDraft, setCustomDraft] = useState(() => ({
    from: toDayInput(view.range.from),
    to: toDayInput(new Date(view.range.to.getTime() - 1)),
  }));
  const [showCustom, setShowCustom] = useState(view.preset === 'custom');
  const [account, setAccount] = useState<SpendAccountRow | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const setSearch = useCallback(
    (patch: SpendExplorerSearchPatch) => {
      void navigate({ to: '/admin', replace: true, search: previous => ({ ...previous, ...patch }) });
    },
    [navigate]
  );

  const timeline = useSpendTimeline({ range: view.range, splitBy: view.split });
  const data = timeline.data;
  const bucketSize = data?.bucket ?? 'day';
  const selected: SpendTimelineBucket | null = data?.buckets.find(b => b.start === view.at) ?? null;

  // The drill-down window: the selected bucket, or the whole range. "New in top 10" compares it
  // with the window just before it - the baseline window for a bucket, the previous period for a range.
  const drill = useMemo((): { range: SpendRange; compare: SpendRange } => {
    if (selected) {
      const step = bucketMs(bucketSize);
      const from = new Date(selected.start);
      return {
        range: { from, to: new Date(from.getTime() + step) },
        compare: { from: new Date(from.getTime() - SPEND_BASELINE_WINDOW[bucketSize] * step), to: from },
      };
    }
    const length = view.range.to.getTime() - view.range.from.getTime();
    return { range: view.range, compare: { from: new Date(view.range.from.getTime() - length), to: view.range.from } };
  }, [selected, bucketSize, view.range]);

  const drillAccounts = useSpendAccounts(drill);
  // KPIs always describe the whole range, even while a bucket is selected.
  const rangeAccounts = useSpendAccounts({ range: view.range, limit: 5 });
  const kpis = useMemo(() => computeKpis(data?.buckets ?? [], rangeAccounts.data), [data, rangeAccounts.data]);
  const rangeLabel = formatRange(view.range);

  const copySummary = async () => {
    if (!data) return;
    const text = buildSlackSummary({
      range: view.range,
      bucket: bucketSize,
      buckets: data.buckets,
      accounts: rangeAccounts.data,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch (error) {
      console.error('Copying the spend summary failed', error);
      setCopyState('error');
    }
    window.setTimeout(() => setCopyState('idle'), 2000);
  };

  const onPreset = (value: PresetValue) => {
    if (value === 'custom') {
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    setAccount(null);
    setSearch({ [KEYS.range]: value, [KEYS.from]: undefined, [KEYS.to]: undefined, [KEYS.at]: undefined });
  };

  const customValid = customRange(customDraft.from, customDraft.to) !== null;
  const applyCustom = () => {
    if (!customValid) return;
    setAccount(null);
    setSearch({
      [KEYS.range]: 'custom',
      [KEYS.from]: customDraft.from,
      [KEYS.to]: customDraft.to,
      [KEYS.at]: undefined,
    });
  };

  const onSelectBucket = useCallback(
    (start: string) => {
      setAccount(null);
      setSearch({ [KEYS.at]: start });
    },
    [setSearch]
  );

  const featureSelection = useMemo(
    (): FeatureCostSelection => ({ audience: view.audience, feature: view.feature, user: view.user }),
    [view.audience, view.feature, view.user]
  );
  const onFeatureSelection = useCallback(
    (patch: Partial<FeatureCostSelection>) => {
      const next: SpendExplorerSearchPatch = {};
      if ('audience' in patch) next[KEYS.audience] = patch.audience === 'all' ? undefined : patch.audience;
      if ('feature' in patch) next[KEYS.feature] = patch.feature ?? undefined;
      if ('user' in patch) next[KEYS.user] = patch.user ?? undefined;
      setSearch(next);
    },
    [setSearch]
  );

  const peakMultiple = kpis.peak && kpis.medianUsd > 0 ? kpis.peak.totalUsd / kpis.medianUsd : null;
  const spikeCount = data?.buckets.filter(b => b.isSpike).length ?? 0;
  const per = bucketSize === 'hour' ? 'hour' : 'day';

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="spend-explorer">
      <AdminPageHeader
        title="Spend explorer"
        description="AI provider cost B4M recorded per request (usage events). All times are UTC."
        actions={
          <Button
            size="sm"
            variant="outlined"
            color={copyState === 'error' ? 'danger' : 'neutral'}
            onClick={() => void copySummary()}
            disabled={!data}
            data-testid="spend-explorer-copy-summary-btn"
          >
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'error'
                ? 'Copy failed, try again'
                : 'Copy summary for Slack'}
          </Button>
        }
      />

      <Stack direction="row" gap={2} flexWrap="wrap" alignItems="center">
        <SegmentedControl<PresetValue>
          aria-label="Date range"
          data-testid="spend-explorer-range"
          options={PRESET_OPTIONS}
          value={showCustom ? 'custom' : (`${view.preset}` as PresetValue)}
          onChange={onPreset}
        />
        {showCustom && (
          <Stack direction="row" gap={1} alignItems="center">
            <Input
              size="sm"
              type="date"
              value={customDraft.from}
              onChange={e => setCustomDraft(d => ({ ...d, from: e.target.value }))}
              slotProps={{ input: { 'aria-label': 'From (UTC)', 'data-testid': 'spend-explorer-custom-from-input' } }}
            />
            <Typography level="body-sm">to</Typography>
            <Input
              size="sm"
              type="date"
              value={customDraft.to}
              onChange={e => setCustomDraft(d => ({ ...d, to: e.target.value }))}
              slotProps={{ input: { 'aria-label': 'To (UTC)', 'data-testid': 'spend-explorer-custom-to-input' } }}
            />
            <Button
              size="sm"
              onClick={applyCustom}
              disabled={!customValid}
              data-testid="spend-explorer-custom-apply-btn"
            >
              Apply
            </Button>
          </Stack>
        )}
        <SegmentedControl<SpendSplitDimension>
          aria-label="Split by"
          data-testid="spend-explorer-split"
          options={SPLIT_OPTIONS}
          value={view.split}
          onChange={value => setSearch({ [KEYS.split]: value })}
        />
        <Checkbox
          size="sm"
          label="Previous period"
          checked={view.showPrevious}
          onChange={e => setSearch({ [KEYS.previous]: e.target.checked ? 'true' : undefined })}
          slotProps={{ input: { 'data-testid': 'spend-explorer-previous-checkbox' } }}
        />
      </Stack>

      <StatStrip aria-label="Spend summary">
        <StatTile
          label="Total cost"
          value={data ? formatUsd(kpis.totalUsd, { compact: true }) : '-'}
          comparison={`${rangeLabel} UTC`}
        />
        <StatTile
          label={`Median per ${per}`}
          value={data ? formatUsd(kpis.medianUsd, { compact: true }) : '-'}
          comparison={spikeCount > 0 ? `${spikeCount} spike ${per}${spikeCount === 1 ? '' : 's'}` : 'No spikes'}
        />
        <StatTile
          label={`Peak ${per}`}
          value={kpis.peak ? formatUsd(kpis.peak.totalUsd, { compact: true }) : '-'}
          comparison={
            kpis.peak
              ? `${formatBucket(kpis.peak.start, bucketSize)}${peakMultiple === null ? '' : `, ${peakMultiple.toFixed(1)}x median`}`
              : undefined
          }
        />
        <StatTile
          label="Top 5 accounts"
          value={kpis.top5Share === null ? '-' : formatShare(kpis.top5Share)}
          comparison="Share of cost in range"
        />
      </StatStrip>

      <ChartSection
        title={`Cost per ${per}`}
        testId={CHART_ID}
        skeletonHeight={280}
        body={
          timeline.isError && !data
            ? {
                kind: 'notice',
                content: (
                  <ErrorState
                    message={`Could not load spend: ${errorMessage(timeline.error)}`}
                    onRetry={() => void timeline.refetch()}
                  />
                ),
              }
            : !data
              ? { kind: 'loading' }
              : {
                  kind: 'ready',
                  caption: `Click a ${per} to see who drove it. Red dots are above ${SPEND_SPIKE_MULTIPLE}x the rolling median of the previous ${SPEND_BASELINE_WINDOW[bucketSize]} ${per}s.`,
                  chart: (
                    <SpendChart
                      testId={`${CHART_ID}-plot`}
                      data={data}
                      showPrevious={view.showPrevious}
                      selectedStart={view.at}
                      onSelectBucket={onSelectBucket}
                    />
                  ),
                  table: (
                    <SpendBucketTable
                      testId={`${CHART_ID}-table`}
                      label={`Cost per ${per}`}
                      buckets={data.buckets}
                      bucketSize={bucketSize}
                    />
                  ),
                }
        }
      />

      {account ? (
        <AccountSpendPanel account={account} range={drill.range} onClose={() => setAccount(null)} />
      ) : (
        <SpendDrillDown
          bucket={selected}
          bucketSize={bucketSize}
          rangeLabel={rangeLabel}
          accounts={drillAccounts.data}
          isLoading={drillAccounts.isLoading}
          error={drillAccounts.isError ? `Could not load accounts: ${errorMessage(drillAccounts.error)}` : undefined}
          onRetry={() => void drillAccounts.refetch()}
          onSelectAccount={setAccount}
          onClear={() => setSearch({ [KEYS.at]: undefined })}
        />
      )}

      <FeatureCostSection
        range={view.range}
        rangeLabel={rangeLabel}
        selection={featureSelection}
        onChange={onFeatureSelection}
      />
    </Stack>
  );
}
