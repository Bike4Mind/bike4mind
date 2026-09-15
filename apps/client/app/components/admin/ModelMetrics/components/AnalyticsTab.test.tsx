import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ModelMetric } from '../types';

// Nivo's Responsive* wrappers measure their container, which is 0x0 under jsdom, so a real
// render draws no axes at all. These stubs expose the axis legends as attributes instead,
// which is the only part of the chart config this suite is about.
vi.mock('@nivo/line', async () => {
  const react = await import('react');
  return {
    ResponsiveLine: ({ data, axisLeft, axisBottom }: any) =>
      react.createElement('div', {
        'data-testid': `nivo-line-${data?.[0]?.id ?? 'unknown'}`,
        'data-legend-left': axisLeft?.legend,
        'data-legend-bottom': axisBottom?.legend,
      }),
  };
});
vi.mock('@nivo/pie', async () => {
  const react = await import('react');
  return { ResponsivePie: () => react.createElement('div', { 'data-testid': 'nivo-pie' }) };
});
vi.mock('@nivo/bar', async () => {
  const react = await import('react');
  return { ResponsiveBar: () => react.createElement('div', { 'data-testid': 'nivo-bar' }) };
});

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
      expect(screen.getByTestId('nivo-line-chars-per-second')).toHaveAttribute('data-legend-left', 'Avg Chars/Second');
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
      expect(screen.queryByTestId('nivo-line-chars-per-second')).not.toBeInTheDocument();
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
      expect(screen.getByTestId('nivo-line-requests')).toHaveAttribute('data-legend-bottom', 'Time');
      expect(screen.getByTestId('nivo-line-context-retrieval')).toHaveAttribute('data-legend-bottom', 'Time');
    });

    it('says daily and Date once the span exceeds it', () => {
      renderTab([metric('2025-09-10T10:00:00'), metric('2025-09-14T10:00:00')]);

      expect(screen.getByTestId('analytics-trends-heading')).toHaveTextContent('Daily Analytics Trends');
      expect(screen.getByTestId('nivo-line-requests')).toHaveAttribute('data-legend-bottom', 'Date');
    });

    it('says hourly on an empty range', () => {
      // Before granularity was published this read "Daily", because the heading was
      // sniffing a ':' out of a label that does not exist when there are no buckets.
      renderTab([]);

      expect(screen.getByTestId('analytics-trends-heading')).toHaveTextContent('Hourly Analytics Trends');
    });
  });
});
