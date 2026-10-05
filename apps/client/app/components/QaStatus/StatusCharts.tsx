import { FC, useMemo, useState } from 'react';
import { Box, Card, Checkbox, Grid, Stack, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import {
  CartesianGrid,
  Dot,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from 'recharts';
import type { QaSeriesPoint } from '@client/app/hooks/data/qaStatus';
import {
  dayLabel,
  durationData,
  isFailing,
  latencyData,
  metricData,
  passRateData,
  percentDomain,
  tooltipLabel,
  type ChartData,
  type ChartRange,
  type ChartSeries,
  type LatencyData,
} from './chartData';
import { QA_THRESHOLD_COLOR, seriesColor } from './qaSeriesColors';

type Mode = 'light' | 'dark';
type ColorOf = (key: string) => string;

/** Which series are toggled off. */
function useSeriesOff() {
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOff(prev => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return { off, toggle };
}

interface TogglesProps {
  id: string;
  keys: string[];
  colorOf: ColorOf;
  off: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

// Doubles as the legend; a single series has nothing to toggle.
const SeriesToggles: FC<TogglesProps> = ({ id, keys, colorOf, off, onToggle }) => {
  if (keys.length < 2) return null;
  return (
    <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
      {keys.map((key, i) => {
        const color = colorOf(key);
        return (
          <Checkbox
            key={key}
            size="sm"
            label={key}
            checked={!off.has(key)}
            onChange={() => onToggle(key)}
            data-testid={`qa-chart-${id}-series-${i}`}
            slotProps={{
              // Joy's color prop is palette-only; these vars are the variant override hooks.
              checkbox: {
                sx: {
                  '--variant-solidBg': color,
                  '--variant-solidHoverBg': color,
                  '--variant-solidActiveBg': color,
                  '--variant-outlinedBorder': color,
                  '--variant-outlinedHoverBorder': color,
                },
              },
              label: { sx: { fontSize: 11 } },
            }}
          />
        );
      })}
    </Stack>
  );
};

/**
 * Lines carry no dots; a point past its limit gets a red-filled one. A series with a single plotted
 * point also gets a plain dot, since a lone point draws no line and would vanish.
 */
function dotFor(series: ChartSeries, data: ChartData, color: string) {
  const plotted = data.rows.filter(r => typeof r[series.key] === 'number').length;
  if (series.limit === undefined && plotted !== 1) return false;
  return function StatusDot({ cx, cy, payload }: DotItemDotProps) {
    if (cx === undefined || cy === undefined) return null;
    const value: unknown = payload?.[series.key];
    if (isFailing(value, series.limit, data.fail)) {
      return (
        <g data-testid="qa-chart-failing-dot">
          <Dot cx={cx} cy={cy} r={5} fill={QA_THRESHOLD_COLOR} stroke={color} strokeWidth={2} />
        </g>
      );
    }
    return plotted === 1 && typeof value === 'number' ? <Dot cx={cx} cy={cy} r={3} fill={color} /> : null;
  };
}

interface PlotProps {
  id: string;
  data: ChartData;
  off: ReadonlySet<string>;
  colorOf: ColorOf;
  height: number;
  /** Fit the y axis to the visible percent values instead of the library's auto domain. */
  fitPercent?: boolean;
}

const Plot: FC<PlotProps> = ({ id, data, off, colorOf, height, fitPercent }) => {
  if (data.rows.length === 0) {
    return (
      <Typography data-testid={`qa-chart-${id}-empty`} level="body-sm" sx={{ py: 6, textAlign: 'center' }}>
        No data in range
      </Typography>
    );
  }
  const visible = data.series.filter(s => !off.has(s.key));
  const yDomain = fitPercent ? percentDomain(data.rows.flatMap(r => visible.map(s => r[s.key]))) : undefined;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data.rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeOpacity={0.15} vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={[data.ticks[0] ?? 'dataMin', 'dataMax']}
          ticks={data.ticks}
          tickFormatter={dayLabel}
          fontSize={11}
        />
        <YAxis fontSize={11} width={40} domain={yDomain ?? ['auto', 'auto']} />
        <Tooltip labelFormatter={t => tooltipLabel(data, t)} />
        {data.thresholds.map(value => (
          <ReferenceLine
            key={value}
            y={value}
            stroke={QA_THRESHOLD_COLOR}
            strokeDasharray="4 4"
            label={{ value: `threshold ${value}`, fontSize: 10, position: 'insideTopRight' }}
          />
        ))}
        {visible.map(s => {
          const color = colorOf(s.key);
          return (
            <Line
              key={s.key}
              dataKey={s.key}
              stroke={color}
              strokeWidth={2}
              dot={dotFor(s, data, color)}
              activeDot={{ r: 4 }}
              // Rows are shared across series: another series' run leaves this key undefined, which must not break the line.
              connectNulls
              isAnimationActive={false}
            />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
};

const HiddenNote: FC<{ count: number }> = ({ count }) =>
  count > 0 ? (
    <Typography level="body-xs">{count} more series hidden; narrow the filters to see them.</Typography>
  ) : null;

interface ChartProps {
  id: string;
  title: string;
  data: ChartData;
  mode: Mode;
  fitPercent?: boolean;
}

// One y-axis, 2px lines, dots only on failing points, series toggles at 2+ series, dashed threshold lines.
const Chart: FC<ChartProps> = ({ id, title, data, mode, fitPercent }) => {
  const { off, toggle } = useSeriesOff();
  const colorOf: ColorOf = key =>
    seriesColor(
      data.series.findIndex(s => s.key === key),
      mode
    );

  return (
    <Card data-testid={`qa-chart-${id}`} variant="outlined">
      <Typography level="title-sm">
        {title}
        {data.unit ? ` (${data.unit})` : ''}
      </Typography>
      <SeriesToggles id={id} keys={data.series.map(s => s.key)} colorOf={colorOf} off={off} onToggle={toggle} />
      <Plot id={id} data={data} off={off} colorOf={colorOf} height={220} fitPercent={fitPercent} />
      <HiddenNote count={data.hidden} />
    </Card>
  );
};

// Thresholds differ per spec, so each label gets its own mini chart; the model toggles are shared.
const LatencyCard: FC<{ data: LatencyData; mode: Mode }> = ({ data, mode }) => {
  const { off, toggle } = useSeriesOff();
  const colorOf: ColorOf = model => seriesColor(data.models.indexOf(model), mode);

  return (
    <Card data-testid="qa-chart-latency" variant="outlined">
      <Typography level="title-sm">
        Latency per model
        {data.unit ? ` (${data.unit})` : ''}
      </Typography>
      <SeriesToggles id="latency" keys={data.models} colorOf={colorOf} off={off} onToggle={toggle} />
      {data.groups.length === 0 ? (
        <Typography data-testid="qa-chart-latency-empty" level="body-sm" sx={{ py: 6, textAlign: 'center' }}>
          No data in range
        </Typography>
      ) : (
        <Grid container spacing={1.5}>
          {data.groups.map(g => (
            <Grid key={g.label} xs={12} lg={6}>
              <Box data-testid={`qa-chart-latency-${g.label}`}>
                <Typography level="body-xs" fontWeight="lg">
                  {g.label}
                </Typography>
                <Plot id={`latency-${g.label}`} data={g.data} off={off} colorOf={colorOf} height={150} />
              </Box>
            </Grid>
          ))}
        </Grid>
      )}
      <HiddenNote count={data.hidden} />
    </Card>
  );
};

interface StatusChartsProps {
  series: QaSeriesPoint[];
  /** 30d plots daily buckets; 7d one point per run. */
  range?: ChartRange;
}

const StatusCharts: FC<StatusChartsProps> = ({ series, range = '7d' }) => {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const charts = useMemo(
    () => [
      { id: 'pass-rate', title: 'Pass rate', data: passRateData(series, range), fitPercent: true },
      { id: 'duration', title: 'Duration', data: durationData(series, range) },
      { id: 'credits', title: 'Credits per model', data: metricData(series, 'credits', range), full: true },
    ],
    [series, range]
  );
  const latency = useMemo(() => latencyData(series, range), [series, range]);
  return (
    <Grid container spacing={1.5}>
      {charts.map(({ full, ...c }) => (
        <Grid key={c.id} xs={12} lg={full ? 12 : 6}>
          <Chart {...c} mode={mode} />
        </Grid>
      ))}
      <Grid xs={12}>
        <LatencyCard data={latency} mode={mode} />
      </Grid>
    </Grid>
  );
};

export default StatusCharts;
