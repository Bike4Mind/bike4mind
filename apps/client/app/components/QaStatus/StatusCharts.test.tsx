import { cloneElement, type ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import StatusCharts from './StatusCharts';
import { QA_THRESHOLD_COLOR } from './qaSeriesColors';

// ResponsiveContainer measures 0x0 in jsdom and renders no children; give the chart a fixed size.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 600, height: 220 }),
}));

const run = (o: Record<string, unknown> = {}) => ({
  runId: 'r1',
  suite: 'Core',
  env: 'staging',
  startedAt: '2026-09-28T09:00:00.000Z',
  status: 'passed' as const,
  passRate: 1,
  durationMs: 60_000,
  metrics: [],
  ...o,
});

/** Local wall-clock time, so day bucketing holds in any timezone. */
const local = (day: number, hour = 0) => new Date(2026, 8, day, hour).toISOString();

const latency = (model: string, label: string, value: number, threshold: number) => ({
  kind: 'latency' as const,
  model,
  label,
  value,
  unit: 's',
  threshold,
});

const checkbox = (testId: string) => screen.getByTestId(testId).querySelector('input') as HTMLInputElement;
const dots = (chartId: string) => [...screen.getByTestId(`qa-chart-${chartId}`).querySelectorAll('.recharts-dot')];
const lineCount = (chartId: string) =>
  screen.getByTestId(`qa-chart-${chartId}`).querySelectorAll('.recharts-line').length;

describe('StatusCharts', () => {
  it('shows an empty state per chart with no data', () => {
    render(<StatusCharts series={[]} />, { wrapper: QaTestWrapper });
    for (const id of ['pass-rate', 'duration', 'credits', 'latency']) {
      expect(screen.getByTestId(`qa-chart-${id}-empty`)).toBeInTheDocument();
    }
  });

  it('renders the pass rate chart when there is data', () => {
    render(<StatusCharts series={[run()]} />, { wrapper: QaTestWrapper });
    expect(screen.getByTestId('qa-chart-pass-rate')).toBeInTheDocument();
    expect(screen.queryByTestId('qa-chart-pass-rate-empty')).toBeNull();
    expect(screen.getByTestId('qa-chart-credits-empty')).toBeInTheDocument();
  });

  it('renders no series checkboxes for a single-series chart', () => {
    render(<StatusCharts series={[run()]} />, { wrapper: QaTestWrapper });
    expect(screen.queryByTestId('qa-chart-pass-rate-series-0')).toBeNull();
  });

  it('toggles a series off and on, all checked by default', () => {
    const series = [run({ passRate: 0.5 }), run({ env: 'production', startedAt: '2026-09-28T10:00:00.000Z' })];
    render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
    expect(checkbox('qa-chart-pass-rate-series-0').checked).toBe(true);
    expect(checkbox('qa-chart-pass-rate-series-1').checked).toBe(true);
    expect(lineCount('pass-rate')).toBe(2);

    fireEvent.click(checkbox('qa-chart-pass-rate-series-0'));
    expect(checkbox('qa-chart-pass-rate-series-0').checked).toBe(false);
    expect(checkbox('qa-chart-pass-rate-series-1').checked).toBe(true);
    expect(lineCount('pass-rate')).toBe(1);
    // Local per chart: the duration chart keeps both lines.
    expect(lineCount('duration')).toBe(2);

    fireEvent.click(checkbox('qa-chart-pass-rate-series-0'));
    expect(checkbox('qa-chart-pass-rate-series-0').checked).toBe(true);
    expect(lineCount('pass-rate')).toBe(2);
  });

  it('fits the pass rate axis to the visible series only', () => {
    const series = [run({ passRate: 0.5 }), run({ env: 'production', startedAt: '2026-09-28T10:00:00.000Z' })];
    render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
    const ticks = () =>
      [
        ...screen
          .getByTestId('qa-chart-pass-rate')
          .querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value'),
      ].map(t => Number(t.textContent));
    expect(Math.min(...ticks())).toBe(45);
    fireEvent.click(checkbox('qa-chart-pass-rate-series-0'));
    expect(Math.min(...ticks())).toBe(95);
  });

  it('keeps a series line connected when other series run in between', () => {
    const series = [
      run({ startedAt: local(28, 9) }),
      run({ env: 'production', startedAt: local(28, 10) }),
      run({ startedAt: local(28, 11) }),
    ];
    render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
    const d = screen.getByTestId('qa-chart-pass-rate').querySelector('.recharts-line-curve')?.getAttribute('d');
    expect(d).toContain('L');
  });

  describe('failing dots', () => {
    it('draws no dots on passing points', () => {
      render(<StatusCharts series={[run(), run({ startedAt: local(28, 10) })]} />, { wrapper: QaTestWrapper });
      expect(dots('pass-rate')).toHaveLength(0);
      expect(dots('duration')).toHaveLength(0);
    });

    it('draws a red-filled dot, outlined in the series color, on a failing pass rate', () => {
      const series = [run(), run({ passRate: 0.5, startedAt: local(28, 10) }), run({ startedAt: local(28, 11) })];
      render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
      const [dot, ...rest] = dots('pass-rate');
      expect(rest).toHaveLength(0);
      expect(dot.getAttribute('fill')).toBe(QA_THRESHOLD_COLOR);
      expect(dot.getAttribute('r')).toBe('5');
      expect(dot.getAttribute('stroke')).toBe(
        screen.getByTestId('qa-chart-pass-rate').querySelector('.recharts-line-curve')?.getAttribute('stroke')
      );
    });

    it('draws a dot only on metric values above their threshold', () => {
      const credits = (value: number) => ({
        kind: 'credits' as const,
        model: 'm',
        value,
        unit: 'credits',
        threshold: 30,
      });
      const series = [
        run({ metrics: [credits(12)] }),
        run({ startedAt: local(28, 10), metrics: [credits(45)] }),
        run({ startedAt: local(28, 11), metrics: [credits(30)] }),
      ];
      render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
      expect(dots('credits')).toHaveLength(1);
    });

    it('draws a plain dot for a series with a single point so it stays visible', () => {
      render(<StatusCharts series={[run()]} />, { wrapper: QaTestWrapper });
      const [dot, ...rest] = dots('duration');
      expect(rest).toHaveLength(0);
      expect(dot.getAttribute('r')).toBe('3');
    });
  });

  describe('range', () => {
    const failingRuns = [
      run({ passRate: 0.5, startedAt: local(28, 9) }),
      run({ passRate: 0.75, startedAt: local(28, 10) }),
      run({ passRate: 0.5, startedAt: local(28, 11) }),
      run({ passRate: 0.5, startedAt: local(29, 9) }),
    ];

    it('plots one point per run on 7d', () => {
      render(<StatusCharts series={failingRuns} range="7d" />, { wrapper: QaTestWrapper });
      expect(dots('pass-rate')).toHaveLength(4);
    });

    it('plots one point per day on 30d', () => {
      render(<StatusCharts series={failingRuns} range="30d" />, { wrapper: QaTestWrapper });
      expect(dots('pass-rate')).toHaveLength(2);
    });

    it('labels each 7d day tick once', () => {
      const series = [
        run({ startedAt: local(28, 9) }),
        run({ startedAt: local(28, 15) }),
        run({ startedAt: local(29, 9) }),
      ];
      render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
      const labels = [
        ...screen
          .getByTestId('qa-chart-pass-rate')
          .querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value'),
      ].map(t => t.textContent);
      expect(labels).toHaveLength(2);
      expect(new Set(labels).size).toBe(2);
    });
  });

  describe('latency small multiples', () => {
    const series = [
      run({
        metrics: [
          latency('model-a', 'ai-latency-short', 3, 5),
          latency('model-b', 'ai-latency-short', 4, 5),
          latency('model-a', 'ai-latency-long', 9, 15),
          latency('model-b', 'ai-latency-long', 20, 15),
        ],
      }),
      run({
        startedAt: local(28, 10),
        metrics: [
          latency('model-a', 'ai-latency-short', 7, 5),
          latency('model-b', 'ai-latency-short', 4, 5),
          latency('model-a', 'ai-latency-long', 18, 15),
          latency('model-b', 'ai-latency-long', 12, 15),
        ],
      }),
    ];
    const mini = (label: string) => screen.getByTestId(`qa-chart-latency-${label}`);

    it('renders one mini chart per label, titled by it, with only its own threshold', () => {
      render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
      expect(mini('ai-latency-short')).toHaveTextContent('ai-latency-short');
      expect(mini('ai-latency-long')).toHaveTextContent('ai-latency-long');
      expect(mini('ai-latency-short').querySelectorAll('.recharts-reference-line')).toHaveLength(1);
      expect(mini('ai-latency-short')).toHaveTextContent('threshold 5');
      expect(mini('ai-latency-short')).not.toHaveTextContent('threshold 15');
      expect(mini('ai-latency-long')).toHaveTextContent('threshold 15');
      expect(mini('ai-latency-short').querySelectorAll('.recharts-line')).toHaveLength(2);
    });

    it('marks values above their own spec threshold only', () => {
      render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
      // short: model-a 7 > 5. long: model-a 18 > 15 and model-b 20 > 15.
      expect(mini('ai-latency-short').querySelectorAll('.recharts-dot')).toHaveLength(1);
      expect(mini('ai-latency-long').querySelectorAll('.recharts-dot')).toHaveLength(2);
    });

    it('hides a model in every mini from the shared checkbox row', () => {
      render(<StatusCharts series={series} />, { wrapper: QaTestWrapper });
      expect(checkbox('qa-chart-latency-series-0').checked).toBe(true);
      fireEvent.click(checkbox('qa-chart-latency-series-0'));
      expect(checkbox('qa-chart-latency-series-0').checked).toBe(false);
      expect(mini('ai-latency-short').querySelectorAll('.recharts-line')).toHaveLength(1);
      expect(mini('ai-latency-long').querySelectorAll('.recharts-line')).toHaveLength(1);
      // Series toggles stay local to the card: credits and the other charts are untouched.
      expect(lineCount('duration')).toBe(1);
    });

    it('counts models past the cap as hidden on the card', () => {
      const metrics = Array.from({ length: 10 }, (_, i) => latency(`model-${i}`, 'ai-latency-short', 1, 5));
      render(<StatusCharts series={[run({ metrics })]} />, { wrapper: QaTestWrapper });
      expect(screen.getByTestId('qa-chart-latency')).toHaveTextContent('2 more series hidden');
    });
  });
});
