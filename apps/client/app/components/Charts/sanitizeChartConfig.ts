import { cssHasRemoteReference } from '@client/app/utils/svgSanitizer';

export type ChartValue = string | number | boolean | null;
export interface ChartRow {
  [key: string]: ChartValue | ChartRow[];
}

export interface ChartSeries {
  type: 'Bar' | 'Line' | 'Area';
  dataKey: string;
  name?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  fillOpacity?: number;
  strokeOpacity?: number;
  opacity?: number;
  barSize?: number;
  stackId?: string | number;
  dot?: boolean;
  activeDot?: boolean;
  unit?: string;
}

export interface SafeChartConfig {
  chartType: string;
  data: ChartRow[];
  config: {
    xAxis?: string;
    yAxis?: string | string[];
    width?: number;
    height?: number;
    colors?: string[];
    legend?: boolean;
    grid?: boolean;
    tooltip?: boolean;
    responsive?: boolean;
    axes?: {
      x?: { dataKey: string; label?: string };
      y?: Array<{ dataKey: string; label?: string; orientation?: 'left' | 'right' }>;
    };
    children?: ChartSeries[];
  };
}

// recharts copies row fields onto SVG elements. Values are already primitives, so only names that
// make React throw for a primitive, or that touch the prototype, are dropped.
const RESERVED_ROW_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'dangerouslySetInnerHTML', 'ref', 'style']);

// A React event prop holding a primitive throws when the event fires. Columns that only look
// like one (onTime, onHand) are kept.
const isDomEventKey = (key: string): boolean => {
  if (!/^on[A-Z]/.test(key)) return false;
  const name = key.replace(/Capture$/, '').toLowerCase();
  return (
    name === 'ondoubleclick' || typeof window === 'undefined' || name in window.HTMLElement.prototype || name in window
  );
};

const warnedKeys = new Set<string>();
const warnDroppedKey = (key: string) => {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(`Chart data column "${key}" is not rendered: the name is reserved.`);
};

const warnedValues = new Set<string>();
const warnDroppedValue = (key: string) => {
  if (warnedValues.has(key)) return;
  warnedValues.add(key);
  console.warn(`Chart data values in column "${key}" are not rendered: they reference a remote resource.`);
};

const MAX_NESTING = 4;
const COLOR =
  /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgba?|hsla?)\((?:[\d\s.,%/+-]|deg|turn|rad|grad)+\)|var\(--[\w-]+\)|url\(#[\w-]+\))$/i;
export const DEFAULT_CHART_COLORS = ['#8884d8', '#82ca9d', '#ffc658', '#ff7c7c', '#8dd1e1'];
const DASHARRAY = /^[\d\s.,]+$/;
const SERIES_TYPES = new Set(['Bar', 'Line', 'Area']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAllowedRowKey = (key: string): boolean => {
  if (!RESERVED_ROW_KEYS.has(key) && !isDomEventKey(key)) return true;
  warnDroppedKey(key);
  return false;
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const label = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
const color = (value: unknown): string | undefined =>
  typeof value === 'string' && COLOR.test(value.trim()) ? value.trim() : undefined;

function sanitizeRow(row: unknown, depth: number): ChartRow | null {
  if (!isRecord(row)) return null;
  const clean: ChartRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (!isAllowedRowKey(key)) continue;
    if (typeof value === 'string') {
      // Checked on every column: recharts can copy any row field onto filter, mask, clip-path or marker attributes.
      if (cssHasRemoteReference(value)) warnDroppedValue(key);
      else clean[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      clean[key] = value;
    } else if (key === 'children' && Array.isArray(value) && depth < MAX_NESTING) {
      // Treemap nests rows under `children`.
      clean[key] = sanitizeRows(value, depth + 1);
    }
  }
  return clean;
}

function sanitizeRows(rows: unknown[], depth = 0): ChartRow[] {
  return rows.map(row => sanitizeRow(row, depth)).filter((row): row is ChartRow => row !== null);
}

function sanitizeSeries(raw: unknown): ChartSeries | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !SERIES_TYPES.has(raw.type)) return null;
  const dataKey = text(raw.dataKey);
  if (dataKey === undefined) return null;
  const strokeDasharray = text(raw.strokeDasharray);
  const stackId = typeof raw.stackId === 'number' ? finiteNumber(raw.stackId) : text(raw.stackId);
  const series: ChartSeries = {
    type: raw.type as ChartSeries['type'],
    dataKey,
    name: text(raw.name),
    fill: color(raw.fill),
    stroke: color(raw.stroke),
    strokeWidth: finiteNumber(raw.strokeWidth),
    strokeDasharray: strokeDasharray && DASHARRAY.test(strokeDasharray) ? strokeDasharray : undefined,
    fillOpacity: finiteNumber(raw.fillOpacity),
    strokeOpacity: finiteNumber(raw.strokeOpacity),
    opacity: finiteNumber(raw.opacity),
    barSize: finiteNumber(raw.barSize),
    stackId,
    dot: bool(raw.dot),
    activeDot: bool(raw.activeDot),
    unit: text(raw.unit),
  };
  return Object.fromEntries(
    Object.entries(series).filter(([, value]) => value !== undefined)
  ) as unknown as ChartSeries;
}

function sanitizeAxes(raw: unknown): SafeChartConfig['config']['axes'] {
  if (!isRecord(raw)) return undefined;
  const axes: NonNullable<SafeChartConfig['config']['axes']> = {};
  if (isRecord(raw.x) && typeof raw.x.dataKey === 'string') {
    axes.x = { dataKey: raw.x.dataKey, label: label(raw.x.label) };
  }
  if (Array.isArray(raw.y)) {
    axes.y = raw.y.filter(isRecord).flatMap(y =>
      typeof y.dataKey === 'string'
        ? [
            {
              dataKey: y.dataKey,
              label: label(y.label),
              orientation:
                y.orientation === 'right'
                  ? ('right' as const)
                  : y.orientation === 'left'
                    ? ('left' as const)
                    : undefined,
            },
          ]
        : []
    );
  }
  return axes;
}

function sanitizeYAxis(raw: unknown): string | string[] | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((key): key is string => typeof key === 'string');
  return undefined;
}

/**
 * Reduces an untrusted chart configuration to the fields RechartsChart renders: rows of
 * primitive values under non-reserved keys, plus typed display options. Anything else is
 * dropped rather than passed through to recharts, which spreads row fields onto SVG elements.
 */
export function sanitizeChartConfig(raw: unknown): SafeChartConfig {
  const source = isRecord(raw) ? raw : {};
  const options = isRecord(source.config) ? source.config : {};
  const colors = Array.isArray(options.colors)
    ? options.colors.map((value, index) => color(value) ?? DEFAULT_CHART_COLORS[index % DEFAULT_CHART_COLORS.length])
    : undefined;
  const config: SafeChartConfig['config'] = {
    xAxis: text(options.xAxis),
    yAxis: sanitizeYAxis(options.yAxis),
    width: finiteNumber(options.width),
    height: finiteNumber(options.height),
    colors: colors && colors.length > 0 ? colors : undefined,
    legend: bool(options.legend),
    grid: bool(options.grid),
    tooltip: bool(options.tooltip),
    responsive: bool(options.responsive),
    axes: sanitizeAxes(options.axes),
    children: Array.isArray(options.children)
      ? options.children.map(sanitizeSeries).filter((series): series is ChartSeries => series !== null)
      : undefined,
  };
  return {
    chartType: typeof source.chartType === 'string' ? source.chartType : '',
    data: Array.isArray(source.data) ? sanitizeRows(source.data) : [],
    config,
  };
}
