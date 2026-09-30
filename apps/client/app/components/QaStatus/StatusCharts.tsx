import { FC, useMemo } from 'react';
import { Card, Grid, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { QaSeriesPoint } from '@client/app/hooks/data/qaStatus';
import { durationData, metricData, passRateData, type ChartData } from './chartData';
import { QA_THRESHOLD_COLOR, seriesColor } from './qaSeriesColors';

const tick = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

interface ChartProps {
  id: string;
  title: string;
  data: ChartData;
  mode: 'light' | 'dark';
  yDomain?: [number, number];
}

// One y-axis, 2px lines, 8px markers, legend only at 2+ series, dashed threshold lines.
const Chart: FC<ChartProps> = ({ id, title, data, mode, yDomain }) => (
  <Card data-testid={`qa-chart-${id}`} variant="outlined">
    <Typography level="title-sm">
      {title}
      {data.unit ? ` (${data.unit})` : ''}
    </Typography>
    {data.rows.length === 0 ? (
      <Typography data-testid={`qa-chart-${id}-empty`} level="body-sm" sx={{ py: 6, textAlign: 'center' }}>
        No data in range
      </Typography>
    ) : (
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data.rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeOpacity={0.15} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={tick}
            fontSize={11}
          />
          <YAxis fontSize={11} width={40} domain={yDomain ?? ['auto', 'auto']} />
          <Tooltip labelFormatter={t => new Date(Number(t)).toLocaleString()} />
          {data.series.length >= 2 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {data.thresholds.map(value => (
            <ReferenceLine
              key={value}
              y={value}
              stroke={QA_THRESHOLD_COLOR}
              strokeDasharray="4 4"
              label={{ value: `threshold ${value}`, fontSize: 10, position: 'insideTopRight' }}
            />
          ))}
          {data.series.map((s, i) => (
            <Line
              key={s.key}
              dataKey={s.key}
              stroke={seriesColor(i, mode)}
              strokeWidth={2}
              dot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    )}
    {data.hidden > 0 && (
      <Typography level="body-xs">{data.hidden} more series hidden; narrow the filters to see them.</Typography>
    )}
  </Card>
);

const StatusCharts: FC<{ series: QaSeriesPoint[] }> = ({ series }) => {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const charts = useMemo(
    () => [
      { id: 'pass-rate', title: 'Pass rate', data: passRateData(series), yDomain: [0, 100] as [number, number] },
      { id: 'duration', title: 'Duration', data: durationData(series) },
      { id: 'credits', title: 'Credits per model', data: metricData(series, 'credits') },
      { id: 'latency', title: 'Latency per model', data: metricData(series, 'latency') },
    ],
    [series]
  );
  return (
    <Grid container spacing={1.5}>
      {charts.map(c => (
        <Grid key={c.id} xs={12} lg={6}>
          <Chart {...c} mode={mode} />
        </Grid>
      ))}
    </Grid>
  );
};

export default StatusCharts;
