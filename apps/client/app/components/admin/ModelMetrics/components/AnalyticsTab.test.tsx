import React, { cloneElement, type ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ModelMetric } from '../types';

// ResponsiveContainer measures 0x0 in jsdom and renders no children; give the charts a fixed size.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 600, height: 300 }),
}));

const mockMetrics = vi.hoisted(() => ({ current: [] as ModelMetric[] }));
vi.mock('@client/app/hooks/useAnalyticsMetrics', () => ({
  useAnalyticsMetrics: () => ({ data: mockMetrics.current, isLoading: false }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));

import { AnalyticsTab } from './AnalyticsTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Zone-less timestamps so the bucket labels match under any TZ, as in chartDataProcessor.test.ts.
const metric = (timestamp: string, charsPerSecond?: number, type = 'text'): ModelMetric => ({
  id: timestamp,
  timestamp,
  model: { name: 'test-model', type },
  tokenUsage: {},
  performance: {
    contextRetrievalTime: 100,
    ...(charsPerSecond === undefined ? {} : { streamingPerformance: { charsPerSecond } }),
  },
  session: {},
  status: 'completed',
});

const renderTab = (metrics: ModelMetric[]) => {
  mockMetrics.current = metrics;
  return render(<AnalyticsTab />, { wrapper: TestWrapper });
};

describe('AnalyticsTab', () => {
  describe('the streaming-speed chart says what it plots', () => {
    const twoBuckets = [metric('2025-09-14T10:00:00', 80), metric('2025-09-14T11:00:00', 120)];

    it('titles it by the quantity and labels the y-axis in chars/second', () => {
      renderTab(twoBuckets);

      expect(screen.getByTestId('analytics-chars-per-second-heading')).toHaveTextContent(
        'Characters Streamed Per Second'
      );
      expect(within(screen.getByTestId('analytics-trend-chars-per-second')).getByText('Avg Chars/Second')).toBeTruthy();
    });

    it('never calls the series an event count', () => {
      renderTab(twoBuckets);

      for (const wording of ['Analytics Event Frequency', 'Events per Hour', 'events/hr', 'analytics frequency']) {
        expect(document.body.textContent).not.toContain(wording);
      }
    });

    it('states the unit in the single-bucket placeholder', () => {
      renderTab([metric('2025-09-14T10:00:00', 95), metric('2025-09-14T10:30:00', 105)]);

      expect(screen.getByTestId('analytics-chars-per-second-single')).toHaveTextContent('100 chars/sec on 09/14 10:00');
      expect(screen.queryByTestId('analytics-trend-chars-per-second')).not.toBeInTheDocument();
    });

    it('names streaming speed, not event data, when the series is empty', () => {
      // Image models carry no streaming performance, so the series has nothing to plot.
      renderTab([metric('2025-09-14T10:00:00', 400, 'image'), metric('2025-09-14T11:00:00', 400, 'image')]);

      expect(screen.getByTestId('analytics-chars-per-second-empty')).toHaveTextContent(
        'No streaming speed data available'
      );
    });
  });

  describe('axis and heading wording follow the granularity the processor chose', () => {
    it('says hourly and Time inside the 48-hour window', () => {
      renderTab([metric('2025-09-14T10:00:00'), metric('2025-09-14T11:00:00')]);

      expect(screen.getByTestId('analytics-trends-heading')).toHaveTextContent('Hourly Analytics Trends');
      expect(within(screen.getByTestId('analytics-trend-requests')).getByText('Time')).toBeTruthy();
      expect(within(screen.getByTestId('analytics-trend-context-retrieval')).getByText('Time')).toBeTruthy();
    });

    it('says daily and Date once the span exceeds it', () => {
      renderTab([metric('2025-09-10T10:00:00'), metric('2025-09-14T10:00:00')]);

      expect(screen.getByTestId('analytics-trends-heading')).toHaveTextContent('Daily Analytics Trends');
      expect(within(screen.getByTestId('analytics-trend-requests')).getByText('Date')).toBeTruthy();
    });

    it('says hourly on an empty range', () => {
      // Before granularity was published this read "Daily", because the heading was
      // sniffing a ':' out of a label that does not exist when there are no buckets.
      renderTab([]);

      expect(screen.getByTestId('analytics-trends-heading')).toHaveTextContent('Hourly Analytics Trends');
    });
  });

  describe('event distribution and response time', () => {
    const timed = (timestamp: string, name: string, totalResponseTime: number): ModelMetric => ({
      ...metric(timestamp),
      model: { name, type: 'text' },
      performance: { totalResponseTime },
    });
    const metrics = [
      timed('2025-09-14T10:00:00', 'alpha', 300),
      timed('2025-09-14T10:05:00', 'alpha', 400),
      timed('2025-09-14T11:00:00', 'beta', 870),
    ];

    it('slices the donut by event type with the count inside', () => {
      renderTab(metrics);

      const donut = screen.getByTestId('analytics-event-distribution-chart');
      expect(within(donut).getByText('alpha')).toBeTruthy();
      expect(within(donut).getByText('2')).toBeTruthy();
      expect(within(donut).getByText('beta')).toBeTruthy();
      expect(within(donut).getByText('1')).toBeTruthy();
    });

    const sliceFills = () =>
      Array.from(
        screen.getByTestId('analytics-event-distribution-chart').querySelectorAll('.recharts-pie-sector path')
      ).map(path => path.getAttribute('fill'));

    it('steps the accent down for a few event types', () => {
      renderTab(metrics);

      const fills = sliceFills();
      expect(fills).toHaveLength(2);
      expect(fills.every(fill => fill?.includes('--joy-palette-admin-accent'))).toBe(true);
    });

    it('takes the chartSeries slots past six event types, where accent steps blur', () => {
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      renderTab(names.map((name, index) => timed(`2025-09-14T10:0${index}:00`, name, 100)));

      const palette = appTheme.colorSchemes.light.palette.admin.chartSeries;
      expect(sliceFills()).toEqual(palette.slice(0, names.length));
    });

    it('draws one bar per event type at its average response time, labelled with the value', () => {
      renderTab(metrics);

      const bars = screen.getByTestId('analytics-response-time-chart');
      expect(bars.querySelectorAll('.recharts-bar-rectangle path')).toHaveLength(2);
      expect(within(bars).getByText('350')).toBeTruthy();
      expect(within(bars).getByText('870')).toBeTruthy();
      expect(within(bars).getByText('Event Type')).toBeTruthy();
      expect(within(bars).getByText('Response Time (ms)')).toBeTruthy();
    });
  });
});
