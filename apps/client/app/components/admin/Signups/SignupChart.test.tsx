import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySignalCounts, type SignupTimeseries } from '@client/app/utils/signupSignals';

const chart = vi.hoisted(() => ({ onClick: undefined as undefined | ((state: unknown) => void) }));
// recharts needs a measured container; jsdom has none, so capture the chart's click handler instead.
vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    ResponsiveContainer: Passthrough,
    ComposedChart: ({ onClick, children }: { onClick?: (state: unknown) => void; children?: React.ReactNode }) => {
      chart.onClick = onClick;
      return <>{children}</>;
    },
    Area: Passthrough,
    Bar: Passthrough,
    CartesianGrid: Passthrough,
    Legend: Passthrough,
    Line: Passthrough,
    Tooltip: Passthrough,
    XAxis: Passthrough,
    YAxis: Passthrough,
  };
});

import { SignupChart } from './SignupChart';

const appTheme = extendTheme({ ...getThemeConfig() });

const bucket = (start: string) => ({
  start,
  total: 3,
  suspected: 1,
  likelyLegit: 2,
  unclassified: 0,
  bySignal: emptySignalCounts(),
  baseline: null,
});

const series: SignupTimeseries = {
  range: '24h',
  bucket: 'hour',
  since: '2026-03-10T10:00:00.000Z',
  until: '2026-03-10T13:00:00.000Z',
  buckets: [bucket('2026-03-10T10:00:00.000Z'), bucket('2026-03-10T11:00:00.000Z'), bucket('2026-03-10T12:00:00.000Z')],
  totals: { total: 9, suspected: 3, likelyLegit: 6, unclassified: 0, bySignal: emptySignalCounts() },
  truncated: false,
  keysTruncated: false,
};

beforeEach(() => {
  chart.onClick = undefined;
});

describe('SignupChart bucket click', () => {
  const setup = () => {
    const onBucketClick = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <SignupChart data={series} onBucketClick={onBucketClick} />
      </CssVarsProvider>
    );
    return onBucketClick;
  };

  it('reports the start of the clicked bucket', () => {
    const onBucketClick = setup();
    chart.onClick!({ activeTooltipIndex: 1 });
    expect(onBucketClick).toHaveBeenCalledWith('2026-03-10T11:00:00.000Z');
  });

  it('ignores a click off the plot instead of picking the oldest bucket', () => {
    const onBucketClick = setup();
    chart.onClick!({ activeTooltipIndex: null });
    chart.onClick!({});
    expect(onBucketClick).not.toHaveBeenCalled();
  });
});
