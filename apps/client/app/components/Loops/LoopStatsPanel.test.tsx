import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ILoop, ILoopStats } from '@bike4mind/common';
import LoopStatsPanel from './LoopStatsPanel';
import { loopTicketElementId } from './loopUi';

// ResponsiveContainer measures 0x0 in jsdom and renders no children; give the chart a fixed size.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 600, height: 200 }),
}));

const mermaidChart = vi.hoisted(() => vi.fn());
vi.mock('@client/app/components/Charts/MermaidChart', () => ({
  default: (props: { chartDefinition: string }) => {
    mermaidChart(props);
    return <pre data-testid="loop-stats-map-chart">{props.chartDefinition}</pre>;
  },
}));

const useLoopStats = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/data/loops', () => ({ useLoopStats }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const outcomes = { done: 2, blocked: 1, unsure: 0, failed: 0, budget_stopped: 0, idle: 0 };
const stage = (name: string, overrides: Partial<ILoopStats['byStage'][number]> = {}) => ({
  stage: name,
  runs: 0,
  outcomes: { ...outcomes, done: 0, blocked: 0 },
  retried: 0,
  medianRunMs: null,
  credits: 0,
  medianTimeInStageMs: null,
  entered: 0,
  backMoves: 0,
  bounces: 0,
  toolsUnavailable: [],
  toolsErrored: [],
  ...overrides,
});

const stats: ILoopStats = {
  days: 30,
  from: '2026-10-11T12:00:00.000Z',
  to: '2026-11-10T12:00:00.000Z',
  headline: {
    throughputPerDay: { value: 1.5, baseline: 1 },
    medianCycleMs: { value: 3 * 60 * 60_000, baseline: null },
    creditsPerClosed: { value: 12, baseline: 10 },
    needsYou: { value: 1, baseline: null },
  },
  byStage: [
    stage('todo'),
    stage('build', {
      runs: 3,
      outcomes,
      retried: 1,
      medianRunMs: 10 * 60_000,
      credits: 30,
      medianTimeInStageMs: 2 * 60 * 60_000,
      entered: 4,
      backMoves: 2,
      bounces: 1,
      toolsErrored: [{ tool: 'git', count: 2 }],
    }),
    stage('done'),
  ],
  daily: [
    { day: '2026-11-09', closed: 1, credits: 20, budget: 100, stages: { todo: 2, build: 1, done: 3 } },
    { day: '2026-11-10', closed: 2, credits: 10, budget: 100, stages: { todo: 1, build: 1, done: 5 } },
  ],
  eras: [{ at: '2026-11-09T08:00:00.000Z', reason: 'budget 50 -> 100' }],
  costByModel: [{ model: 'model-a', runs: 3, credits: 30 }],
  humanQueue: [
    {
      workItemId: 't1',
      title: 'Pick an API',
      stage: 'build',
      reason: 'unsure',
      since: '2026-11-08T00:00:00.000Z',
      executionId: 'run-1',
    },
  ],
  ratings: { up: 2, down: 1, unrated: 3 },
  directives: { pushedBack: 1, overruled: 0 },
  historyBegins: '2026-11-01T00:00:00.000Z',
  truncated: false,
};

const loop = {
  id: 'l1',
  name: 'Factory',
  stages: ['todo', 'build', 'done'],
  stageConfig: [{ stage: 'build', runner: 'desktop' }],
} as unknown as ILoop;

const renderPanel = (onViewRun = vi.fn()) =>
  render(
    <Wrapper>
      <LoopStatsPanel
        loop={loop}
        tickets={{
          stages: [
            { stage: 'todo', tickets: [] },
            { stage: 'build', tickets: [{ id: 't1' }] as never },
            { stage: 'done', tickets: [] },
          ],
          runLimit: 6,
        }}
        loops={[{ id: 'o1', name: 'Overseer', oversees: ['l1'] }]}
        onViewRun={onViewRun}
      />
    </Wrapper>
  );

describe('LoopStatsPanel', () => {
  it('renders the headline tiles with their baselines, charts, tables, queue and ratings', () => {
    useLoopStats.mockReturnValue({ data: stats, isLoading: false });
    const onViewRun = vi.fn();
    renderPanel(onViewRun);

    expect(screen.getByTestId('loop-stats-tile-throughput')).toHaveTextContent('1.5');
    expect(screen.getByTestId('loop-stats-tile-throughput-baseline')).toHaveTextContent('1.0 the window before');
    expect(screen.getByTestId('loop-stats-tile-cycle')).toHaveTextContent('3h');
    expect(screen.queryByTestId('loop-stats-tile-cycle-baseline')).toBeNull();
    expect(screen.getByTestId('loop-stats-tile-needs-you')).toHaveTextContent('1');

    expect(screen.getByTestId('loop-stats-throughput').querySelectorAll('.recharts-bar-rectangle')).toHaveLength(2);
    expect(screen.getByTestId('loop-stats-flow').querySelectorAll('.recharts-area')).toHaveLength(3);
    expect(screen.getByTestId('loop-stats-flow').querySelector('.recharts-reference-line')).not.toBeNull();
    expect(screen.getByTestId('loop-stats-eras')).toHaveTextContent('2026-11-09: budget 50 -> 100');
    expect(screen.getByTestId('loop-stats-spend').querySelectorAll('.recharts-line')).toHaveLength(2);

    const build = screen.getByTestId('loop-stats-stage-build');
    expect(build).toHaveTextContent('2 done, 1 blocked');
    expect(build).toHaveTextContent('10m');
    expect(build).toHaveTextContent('git (2)');
    expect(within(screen.getByTestId('loop-stats-stage-todo')).getAllByText('-').length).toBeGreaterThan(0);
    expect(screen.getByTestId('loop-stats-cost')).toHaveTextContent('model-a');

    const row = screen.getByTestId('loop-stats-human-queue-row');
    expect(row).toHaveTextContent('build - asked you - updated 2026-11-08');
    fireEvent.click(within(row).getByText('Pick an API'));
    expect(onViewRun).toHaveBeenCalledWith('run-1');

    expect(screen.getByTestId('loop-stats-ratings')).toHaveTextContent('2 up, 1 down, 3 unrated');
    expect(screen.getByTestId('loop-stats-history-note')).toHaveTextContent('2026-11-01');
  });

  it('renders the loop map from the config, live counts and stats', () => {
    useLoopStats.mockReturnValue({ data: stats, isLoading: false });
    renderPanel();
    const map = screen.getByTestId('loop-stats-map-chart').textContent!;
    expect(map).toContain('s1["build (desktop) - 1"]');
    expect(map).toContain('human gate');
    expect(map).toContain('Needs you (1)');
    expect(map).toContain('o0["Overseer"] -.->|oversees| loop');
  });

  it('jumps to the board card for a queue row with no run', () => {
    useLoopStats.mockReturnValue({
      data: {
        ...stats,
        humanQueue: [
          {
            workItemId: 't2',
            title: 'Blocked one',
            stage: 'build',
            reason: 'blocked',
            since: stats.humanQueue[0].since,
          },
        ],
      },
      isLoading: false,
    });
    const card = document.createElement('div');
    card.id = loopTicketElementId('t2');
    card.tabIndex = -1;
    card.scrollIntoView = vi.fn();
    document.body.appendChild(card);
    const onViewRun = vi.fn();
    renderPanel(onViewRun);

    fireEvent.click(screen.getByText('Blocked one'));
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(card);
    expect(onViewRun).not.toHaveBeenCalled();
    card.remove();
  });

  it('asks for the chosen window', () => {
    useLoopStats.mockReturnValue({ data: undefined, isLoading: true });
    renderPanel();
    expect(useLoopStats).toHaveBeenLastCalledWith('l1', 30);
  });
});
