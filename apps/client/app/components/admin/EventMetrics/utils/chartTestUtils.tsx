import type { ReactNode } from 'react';

// The recharts props that carry a color. Left unset, recharts paints these from its hex defaults.
const COLOR_PROPS = [
  'fill',
  'stroke',
  'cursor',
  'contentStyle',
  'labelStyle',
  'itemStyle',
  'tick',
  'tickLine',
  'axisLine',
  'wrapperStyle',
  'dot',
  'activeDot',
] as const;

// Per chart part, the color props whose recharts default is a hex value.
const REQUIRED_COLOR_PROPS: Record<string, readonly string[]> = {
  CartesianGrid: ['stroke'],
  XAxis: ['tick', 'tickLine', 'axisLine'],
  YAxis: ['tick', 'tickLine', 'axisLine'],
  Tooltip: ['cursor', 'contentStyle'],
  Pie: ['stroke'],
  Cell: ['fill'],
  Bar: ['fill'],
  Line: ['stroke', 'dot', 'activeDot'],
};

const PARTS = [
  'ResponsiveContainer',
  'BarChart',
  'Bar',
  'LineChart',
  'Line',
  'PieChart',
  'Pie',
  'Cell',
  'XAxis',
  'YAxis',
  'CartesianGrid',
  'Tooltip',
  'Legend',
] as const;

const recordPart = (part: string) =>
  function RecordedChartPart(props: Record<string, unknown> & { children?: ReactNode }) {
    const colors = Object.fromEntries(COLOR_PROPS.filter(key => key in props).map(key => [key, props[key]]));
    return (
      <span data-chart-part={part} data-chart-colors={JSON.stringify(colors)}>
        {props.children}
      </span>
    );
  };

/** A recharts stand-in for `vi.mock('recharts', ...)`: each part renders a span recording its color props. */
export const recordingRecharts = Object.fromEntries(PARTS.map(part => [part, recordPart(part)]));

const recordedColors = (element: HTMLElement): Record<string, unknown> =>
  JSON.parse(element.dataset.chartColors ?? '{}');

/**
 * What a rendered chart (under `recordingRecharts`) was colored with: every hex value it was given, and
 * every color prop left to a recharts hex default, as `Part.prop`.
 */
export function chartColorReport(container: HTMLElement): { hex: string[]; unset: string[] } {
  const hex: string[] = [];
  const unset: string[] = [];
  container.querySelectorAll<HTMLElement>('[data-chart-part]').forEach(element => {
    const part = element.dataset.chartPart ?? '';
    const colors = recordedColors(element);
    hex.push(...(JSON.stringify(colors).match(/#[0-9a-f]{3,8}\b/gi) ?? []).map(value => `${part}: ${value}`));
    for (const prop of REQUIRED_COLOR_PROPS[part] ?? []) {
      if (!(prop in colors)) unset.push(`${part}.${prop}`);
    }
  });
  return { hex, unset };
}

/** The `fill` each rendered part of the given kind was colored with, in render order. */
export function chartFills(container: HTMLElement, part: string): unknown[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-chart-part="${part}"]`)).map(
    element => recordedColors(element).fill
  );
}
