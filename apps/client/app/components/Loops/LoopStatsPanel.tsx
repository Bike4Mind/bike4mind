import { useState, type ReactNode } from 'react';
import { Box, Card, CircularProgress, Link, Option, Select, Stack, Table, Typography } from '@mui/joy';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { LOOP_STATS_WINDOWS, type ILoop, type ILoopStats, type LoopStatsWindow } from '@bike4mind/common';
import { useLoopStats, type ILoopTicketsResponse } from '@client/app/hooks/data/loops';
import MermaidChart from '@client/app/components/Charts/MermaidChart';
import { buildLoopMap, formatDuration } from './loopMap';
import { formatCredits } from './loopUi';

/** One color per stage band, cycled; readable on both themes. */
const STAGE_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#9c755f'];
const ACCENT = '#4e79a7';
const BASELINE = '#9c9c9c';
const CHART_HEIGHT = 200;

const dash = (value: number | null | undefined, format: (n: number) => string = String) =>
  value === null || value === undefined ? '-' : format(value);
const perDay = (n: number) => n.toFixed(1);
const credits = (n: number) => formatCredits(Math.round(n * 100) / 100);
const dayTick = (day: string) => day.slice(5);

function Tile({
  label,
  testId,
  figure,
  format,
}: {
  label: string;
  testId: string;
  figure: { value: number | null; baseline: number | null };
  format: (n: number) => string;
}) {
  return (
    <Card size="sm" variant="soft" sx={{ minWidth: 150, flex: 1 }} data-testid={`loop-stats-tile-${testId}`}>
      <Typography level="body-xs">{label}</Typography>
      <Typography level="title-lg">{dash(figure.value, format)}</Typography>
      {figure.baseline !== null && (
        <Typography level="body-xs" color="neutral" data-testid={`loop-stats-tile-${testId}-baseline`}>
          {dash(figure.baseline, format)} the window before
        </Typography>
      )}
    </Card>
  );
}

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <Box data-testid={testId}>
      <Typography level="title-sm" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

const outcomeCell = (row: ILoopStats['byStage'][number]) =>
  row.runs === 0
    ? '-'
    : [
        `${row.outcomes.done} done`,
        row.outcomes.blocked && `${row.outcomes.blocked} blocked`,
        row.outcomes.unsure && `${row.outcomes.unsure} unsure`,
        row.outcomes.failed && `${row.outcomes.failed} failed`,
        row.outcomes.budget_stopped && `${row.outcomes.budget_stopped} budget`,
        row.outcomes.idle && `${row.outcomes.idle} idle`,
      ]
        .filter(Boolean)
        .join(', ');

const toolsCell = (tools: { tool: string; count: number }[]) =>
  tools.length === 0 ? '-' : tools.map(({ tool, count }) => `${tool} (${count})`).join(', ');

/**
 * A loop's stats (`GET /api/loops/:id/stats`) and its map. Mounted only while the Stats accordion is open, so the
 * stats are fetched only then. `onViewRun` opens a human-queue ticket's run in the page's run drawer.
 */
export default function LoopStatsPanel({
  loop,
  tickets,
  loops,
  onViewRun,
}: {
  loop: ILoop;
  tickets?: ILoopTicketsResponse;
  loops: Pick<ILoop, 'id' | 'name' | 'oversees' | 'triggers'>[];
  onViewRun: (executionId: string) => void;
}) {
  const [days, setDays] = useState<LoopStatsWindow>(30);
  const { data: stats, isLoading, error } = useLoopStats(loop.id, days);

  const named = (ids: string[]) => loops.filter(other => ids.includes(other.id));
  const map =
    stats &&
    buildLoopMap({
      loop,
      stageCounts: Object.fromEntries((tickets?.stages ?? []).map(group => [group.stage, group.tickets.length])),
      byStage: stats.byStage,
      needsYou: stats.headline.needsYou.value ?? 0,
      overseers: loops.filter(other => other.oversees?.includes(loop.id)),
      workers: named(loop.oversees ?? []),
      handoffTargets: named([
        ...new Set([
          ...(loop.handoffTargets ?? []),
          ...loops.filter(other => other.triggers?.some(t => t.fromLoopId === loop.id)).map(other => other.id),
        ]),
      ]),
    });
  const stageKeys = loop.stages;
  const cfd = stats?.daily ?? [];

  return (
    <Stack gap={2} data-testid="loop-stats-panel">
      <Stack direction="row" gap={2} alignItems="center" flexWrap="wrap">
        <Select
          size="sm"
          value={days}
          onChange={(_, value) => value && setDays(value)}
          data-testid="loop-stats-window-select"
        >
          {LOOP_STATS_WINDOWS.map(window => (
            <Option key={window} value={window}>
              Last {window} days
            </Option>
          ))}
        </Select>
        {stats?.historyBegins && (
          <Typography level="body-xs" color="neutral" data-testid="loop-stats-history-note">
            Stage history began {stats.historyBegins.slice(0, 10)}; older tickets count from when they were created.
          </Typography>
        )}
        {stats?.truncated && (
          <Typography level="body-xs" color="warning" data-testid="loop-stats-truncated">
            This loop has more runs or tickets than one read covers; figures leave out the oldest ones.
          </Typography>
        )}
      </Stack>

      {isLoading && <CircularProgress size="sm" />}
      {error && !stats && (
        <Typography level="body-sm" color="danger" data-testid="loop-stats-error">
          {"Couldn't load the stats. Try again shortly."}
        </Typography>
      )}

      {stats && (
        <>
          {map && (
            <Section title="Loop map" testId="loop-stats-map">
              <MermaidChart chartDefinition={map} readOnly chromeless />
            </Section>
          )}

          <Stack direction="row" gap={1} flexWrap="wrap">
            <Tile label="Closed per day" testId="throughput" figure={stats.headline.throughputPerDay} format={perDay} />
            <Tile
              label="Median cycle time"
              testId="cycle"
              figure={stats.headline.medianCycleMs}
              format={formatDuration}
            />
            <Tile
              label="Credits per closed ticket"
              testId="credits"
              figure={stats.headline.creditsPerClosed}
              format={credits}
            />
            <Tile label="Waiting on you" testId="needs-you" figure={stats.headline.needsYou} format={String} />
          </Stack>

          <Section title="Throughput" testId="loop-stats-throughput">
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <BarChart data={stats.daily} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeOpacity={0.15} vertical={false} />
                <XAxis dataKey="day" tickFormatter={dayTick} fontSize={11} />
                <YAxis fontSize={11} width={32} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="closed" name="Closed" fill={ACCENT} isAnimationActive={false} />
                {stats.headline.throughputPerDay.baseline !== null && (
                  <ReferenceLine
                    y={stats.headline.throughputPerDay.baseline}
                    stroke={BASELINE}
                    strokeDasharray="4 4"
                    label={{ value: 'before', fontSize: 10, position: 'insideTopRight' }}
                  />
                )}
              </BarChart>
            </ResponsiveContainer>
          </Section>

          <Section title="Cumulative flow" testId="loop-stats-flow">
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <AreaChart data={cfd} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeOpacity={0.15} vertical={false} />
                <XAxis dataKey="day" tickFormatter={dayTick} fontSize={11} />
                <YAxis fontSize={11} width={32} allowDecimals={false} />
                <Tooltip />
                {[...stageKeys].reverse().map((stage, i) => {
                  const color = STAGE_COLORS[(stageKeys.length - 1 - i) % STAGE_COLORS.length];
                  return (
                    <Area
                      key={stage}
                      dataKey={(day: ILoopStats['daily'][number]) => day.stages[stage] ?? 0}
                      name={stage}
                      stackId="flow"
                      stroke={color}
                      fill={color}
                      isAnimationActive={false}
                    />
                  );
                })}
                {stats.eras.map(era => (
                  <ReferenceLine
                    key={era.at}
                    x={era.at.slice(0, 10)}
                    stroke={BASELINE}
                    strokeDasharray="2 2"
                    label={{ value: era.reason.slice(0, 40), fontSize: 10, position: 'insideTopLeft' }}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
            {stats.eras.length > 0 && (
              <Stack component="ul" sx={{ m: 0, pl: 2 }} data-testid="loop-stats-eras">
                {stats.eras.map(era => (
                  <Typography key={era.at} component="li" level="body-xs">
                    {era.at.slice(0, 10)}: {era.reason}
                  </Typography>
                ))}
              </Stack>
            )}
          </Section>

          <Section title="Spend per day" testId="loop-stats-spend">
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <LineChart data={stats.daily} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeOpacity={0.15} vertical={false} />
                <XAxis dataKey="day" tickFormatter={dayTick} fontSize={11} />
                <YAxis fontSize={11} width={40} />
                <Tooltip />
                <Line
                  dataKey="credits"
                  name="Credits"
                  stroke={ACCENT}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="budget"
                  name="Budget"
                  stroke={BASELINE}
                  strokeDasharray="4 4"
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </Section>

          <Section title="By stage" testId="loop-stats-by-stage">
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="sm" sx={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Runs</th>
                    <th style={{ width: '18%' }}>Outcomes</th>
                    <th>Retried</th>
                    <th>Median run</th>
                    <th>Credits</th>
                    <th>Median time in stage</th>
                    <th>Back-moves</th>
                    <th>Bounces</th>
                    <th>Tools missing</th>
                    <th>Tools failing</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byStage.map(row => (
                    <tr key={row.stage} data-testid={`loop-stats-stage-${row.stage}`}>
                      <td>{row.stage}</td>
                      <td>{row.runs || '-'}</td>
                      <td>{outcomeCell(row)}</td>
                      <td>{row.runs ? row.retried : '-'}</td>
                      <td>{dash(row.medianRunMs, formatDuration)}</td>
                      <td>{row.runs ? credits(row.credits) : '-'}</td>
                      <td>{dash(row.medianTimeInStageMs, formatDuration)}</td>
                      <td>{row.backMoves}</td>
                      <td>{row.bounces}</td>
                      <td>{toolsCell(row.toolsUnavailable)}</td>
                      <td>{toolsCell(row.toolsErrored)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Box>
          </Section>

          <Section title="Cost by model" testId="loop-stats-cost">
            {stats.costByModel.length === 0 ? (
              <Typography level="body-sm">No runs in this window.</Typography>
            ) : (
              <Table size="sm">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Runs</th>
                    <th>Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.costByModel.map(row => (
                    <tr key={row.model}>
                      <td>{row.model}</td>
                      <td>{row.runs}</td>
                      <td>{credits(row.credits)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>

          <Section title="Waiting on you" testId="loop-stats-human-queue">
            {stats.humanQueue.length === 0 ? (
              <Typography level="body-sm">Nothing is waiting on you.</Typography>
            ) : (
              <Stack gap={0.5}>
                {stats.humanQueue.map(row => (
                  <Stack
                    key={`${row.workItemId ?? ''}-${row.executionId ?? ''}`}
                    direction="row"
                    gap={1}
                    alignItems="center"
                    flexWrap="wrap"
                    data-testid="loop-stats-human-queue-row"
                  >
                    {row.executionId ? (
                      <Link component="button" level="body-sm" onClick={() => onViewRun(row.executionId!)}>
                        {row.title}
                      </Link>
                    ) : (
                      <Typography level="body-sm">{row.title}</Typography>
                    )}
                    <Typography level="body-xs" color="neutral">
                      {[
                        row.stage,
                        row.reason === 'unsure' ? 'asked you' : 'blocked',
                        `updated ${row.since.slice(0, 10)}`,
                      ]
                        .filter(Boolean)
                        .join(' - ')}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}
          </Section>

          <Typography level="body-sm" data-testid="loop-stats-ratings">
            Closed tickets rated: {stats.ratings.up} up, {stats.ratings.down} down, {stats.ratings.unrated} unrated.
            Directives pushed back: {stats.directives.pushedBack}, overruled: {stats.directives.overruled}.
          </Typography>
        </>
      )}
    </Stack>
  );
}
