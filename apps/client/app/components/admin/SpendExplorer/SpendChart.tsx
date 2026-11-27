import { memo, useMemo } from 'react';
import { useTheme } from '@mui/joy';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import type { SpendBucketSize, SpendSplitDimension, SpendTimelineResponse } from '@bike4mind/common';
import {
  BAD,
  COMPARISON_OPACITY,
  BORDER,
  ChartFrame,
  INK_MUTED,
  WARN,
  tooltipFor,
  xAxisProps,
  yAxisProps,
  type ChartLegendItem,
} from '../shared/chartParts';
import { adminChartSeries } from '../EventMetrics/utils/chartTheme';
import { formatBucket, formatUsd, multipleOfBaseline } from './spendExplorerModel';
import { seriesLabel } from './seriesLabels';

export const SPEND_CHART_HEIGHT = 280;

// Past this many series the opacity steps of the accent blur; switch to the chartSeries slots.
const ACCENT_STEP_MAX = 6;

type ChartRow = {
  label: string;
  start: string;
  totalUsd: number;
  baselineUsd: number;
  previousUsd: number;
  isSpike: boolean;
  series: Record<string, number>;
};

type SpendChartProps = {
  testId: string;
  data: SpendTimelineResponse;
  showPrevious: boolean;
  selectedStart: string | null;
  onSelectBucket: (start: string) => void;
};

function useSeriesColors(count: number): string[] {
  const theme = useTheme();
  const palette = theme.palette.admin.chartSeries;
  return useMemo(
    () =>
      count <= ACCENT_STEP_MAX
        ? adminChartSeries(count)
        : Array.from({ length: count }, (_, i) => palette[i % palette.length]),
    [count, palette]
  );
}

/**
 * Stacked cost bars per bucket with a dashed rolling-median baseline, spike dots,
 * suspension markers and an optional previous-period ghost line. Memoized and
 * animation-free: the point count is bounded by the server (<= 400 days or 168 hours).
 */
function SpendChartInner({ testId, data, showPrevious, selectedStart, onSelectBucket }: SpendChartProps) {
  const bucket: SpendBucketSize = data.bucket;
  const split: SpendSplitDimension = data.splitBy;
  const colors = useSeriesColors(data.seriesKeys.length);

  const rows: ChartRow[] = useMemo(
    // A cached timeline can arrive with `series` dropped on empty buckets.
    () => data.buckets.map(b => ({ ...b, series: b.series ?? {}, label: formatBucket(b.start, bucket) })),
    [data.buckets, bucket]
  );

  // Each marker lands on the bucket it falls in; the x axis is categorical.
  const markerLabels = useMemo(() => {
    const step = bucket === 'hour' ? 3600_000 : 86_400_000;
    const labels = new Set<string>();
    for (const marker of data.markers) {
      const start = new Date(Math.floor(new Date(marker.at).getTime() / step) * step).toISOString();
      const row = rows.find(r => new Date(r.start).toISOString() === start);
      if (row) labels.add(row.label);
    }
    return [...labels];
  }, [data.markers, rows, bucket]);

  const legend: ChartLegendItem[] = useMemo(
    () => [
      ...data.seriesKeys.map((key, i) => ({ label: seriesLabel(split, key), color: colors[i] })),
      { label: 'Rolling median', color: INK_MUTED, dashed: true },
      ...(showPrevious ? [{ label: 'Previous period', color: INK_MUTED, opacity: COMPARISON_OPACITY }] : []),
      ...(markerLabels.length ? [{ label: 'Suspension', color: WARN, dashed: true }] : []),
    ],
    [data.seriesKeys, split, colors, showPrevious, markerLabels.length]
  );

  const tooltip = useMemo(
    () =>
      tooltipFor<ChartRow>(`${testId}-tooltip`, row => {
        const multiple = multipleOfBaseline(row);
        return {
          title: `${row.label} UTC${row.isSpike ? ' - spike' : ''}`,
          lines: [
            { label: 'Total', value: formatUsd(row.totalUsd) },
            ...data.seriesKeys
              .filter(key => (row.series[key] ?? 0) > 0)
              .map(key => ({
                label: seriesLabel(split, key),
                value: formatUsd(row.series[key] ?? 0),
                color: colors[data.seriesKeys.indexOf(key)],
              })),
            {
              label: 'Rolling median',
              value: `${formatUsd(row.baselineUsd)}${multiple === null ? '' : ` (${multiple.toFixed(1)}x)`}`,
              color: INK_MUTED,
            },
            ...(showPrevious
              ? [{ label: 'Previous period', value: formatUsd(row.previousUsd), color: INK_MUTED }]
              : []),
          ],
        };
      }),
    [testId, data.seriesKeys, split, colors, showPrevious]
  );

  const selectedLabel = rows.find(r => r.start === selectedStart)?.label;

  return (
    <ChartFrame testId={testId} legend={legend} height={SPEND_CHART_HEIGHT}>
      <ComposedChart
        data={rows}
        margin={{ top: 12, right: 4, left: 0, bottom: 0 }}
        onClick={state => {
          const index = Number(state?.activeTooltipIndex);
          if (Number.isInteger(index) && rows[index]) onSelectBucket(rows[index].start);
        }}
        style={{ cursor: 'pointer' }}
      >
        <CartesianGrid vertical={false} stroke={BORDER} />
        <XAxis dataKey="label" {...xAxisProps} minTickGap={16} />
        <YAxis tickFormatter={(v: number) => formatUsd(v, { compact: true })} width={72} {...yAxisProps} />
        <Tooltip cursor={{ fill: BORDER, fillOpacity: 0.4 }} content={tooltip} />
        {selectedLabel && <ReferenceLine x={selectedLabel} stroke={INK_MUTED} strokeWidth={2} />}
        {markerLabels.map(label => (
          <ReferenceLine key={`marker-${label}`} x={label} stroke={WARN} strokeDasharray="2 3" />
        ))}
        {data.seriesKeys.map((key, i) => (
          <Bar
            key={key}
            dataKey={(row: ChartRow) => row.series[key] ?? 0}
            name={seriesLabel(split, key)}
            stackId="cost"
            fill={colors[i]}
            isAnimationActive={false}
          />
        ))}
        <Line
          dataKey="baselineUsd"
          name="Rolling median"
          stroke={INK_MUTED}
          strokeDasharray="4 4"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        {showPrevious && (
          <Line
            dataKey="previousUsd"
            name="Previous period"
            stroke={INK_MUTED}
            strokeOpacity={COMPARISON_OPACITY}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        )}
        {rows
          .filter(row => row.isSpike)
          .map(row => (
            <ReferenceDot key={`spike-${row.start}`} x={row.label} y={row.totalUsd} r={4} fill={BAD} stroke="none" />
          ))}
      </ComposedChart>
    </ChartFrame>
  );
}

export const SpendChart = memo(SpendChartInner);
