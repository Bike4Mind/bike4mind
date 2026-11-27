import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpendTimelineBucket, SpendTimelineResponse } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const PLOT = { width: 640, height: 280 };

// recharts needs a measured container and jsdom has none; hand the real chart a fixed size.
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children?: ReactNode }) =>
      isValidElement(children) ? cloneElement(children as ReactElement<typeof PLOT>, PLOT) : null,
  };
});

import { SpendChart } from './SpendChart';

const appTheme = extendTheme({ ...getThemeConfig() });

const bucket = (start: string, bedrockUsd: number): SpendTimelineBucket => ({
  start,
  totalUsd: bedrockUsd,
  series: bedrockUsd > 0 ? { bedrock: bedrockUsd } : {},
  baselineUsd: 0,
  isSpike: false,
  previousUsd: 0,
});

// A cached timeline can drop the empty per-bucket `series` object entirely.
const withoutSeries = (b: SpendTimelineBucket) => {
  const { series: _dropped, ...rest } = b;
  return rest as SpendTimelineBucket;
};

// One Bedrock chat on the middle day of a three-day range.
const timeline = (buckets: SpendTimelineBucket[]): SpendTimelineResponse => ({
  bucket: 'day',
  splitBy: 'provider',
  seriesKeys: ['bedrock'],
  buckets,
  markers: [],
});

const EMPTY_DAY = '2026-03-10T00:00:00.000Z';
const CHAT_DAY = '2026-03-11T00:00:00.000Z';
const LAST_DAY = '2026-03-12T00:00:00.000Z';

const renderChart = (data: SpendTimelineResponse) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SpendChart testId="spend-chart" data={data} showPrevious={false} selectedStart={null} onSelectBucket={vi.fn()} />
    </CssVarsProvider>
  );

// recharts maps the pointer to a bucket through the wrapper's measured box, which jsdom reports as zero.
const hoverBucketAt = async (x: number) => {
  const wrapper = document.querySelector('.recharts-wrapper') as HTMLElement;
  fireEvent.mouseMove(wrapper, { clientX: x, clientY: 100 });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
  });
};

const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: PLOT.width, bottom: PLOT.height, ...PLOT, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: PLOT.width });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: PLOT.height });
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
});

describe('SpendChart', () => {
  it('renders when empty buckets arrive without a series object', () => {
    renderChart(
      timeline([withoutSeries(bucket(EMPTY_DAY, 0)), bucket(CHAT_DAY, 0.42), withoutSeries(bucket(LAST_DAY, 0))])
    );

    expect(screen.getByTestId('spend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('spend-chart-legend')).toHaveTextContent('Bedrock (AWS)');
  });

  it('shows only the total for a bucket without a series object', async () => {
    renderChart(
      timeline([withoutSeries(bucket(EMPTY_DAY, 0)), bucket(CHAT_DAY, 0.42), withoutSeries(bucket(LAST_DAY, 0))])
    );

    await hoverBucketAt(550);

    const tooltip = screen.getByTestId('spend-chart-tooltip-tooltip');
    expect(tooltip).toHaveTextContent('Mar 12');
    expect(tooltip).toHaveTextContent('Total');
    expect(tooltip).not.toHaveTextContent('Bedrock (AWS)');
  });

  it('still lists the series cost for a bucket that has one', async () => {
    renderChart(
      timeline([withoutSeries(bucket(EMPTY_DAY, 0)), bucket(CHAT_DAY, 0.42), withoutSeries(bucket(LAST_DAY, 0))])
    );

    await hoverBucketAt(350);

    const tooltip = screen.getByTestId('spend-chart-tooltip-tooltip');
    expect(tooltip).toHaveTextContent('Mar 11');
    expect(tooltip).toHaveTextContent('Bedrock (AWS)');
  });
});
