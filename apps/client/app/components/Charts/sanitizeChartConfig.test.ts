import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CHART_COLORS, sanitizeChartConfig } from './sanitizeChartConfig';

describe('sanitizeChartConfig', () => {
  it('drops keys React rejects with a primitive value and warns once per key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { data } = sanitizeChartConfig({
      chartType: 'BarChart',
      data: [
        {
          month: 'Jan',
          sales: 10,
          dangerouslySetInnerHTML: { __html: '<img src=x onerror=alert(1)>' },
          onClick: 'alert(1)',
          onMouseEnterCapture: 'x',
          style: 'background:red',
          ref: 'x',
        },
        { month: 'Feb', sales: 20, style: 'x' },
      ],
    });
    expect(data).toEqual([
      { month: 'Jan', sales: 10 },
      { month: 'Feb', sales: 20 },
    ]);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('"style"'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('keeps ordinary columns whose names overlap DOM attributes', () => {
    const row = {
      class: 'A',
      key: 'k1',
      src: 'web',
      href: 'docs',
      onTime: 0.9,
      onHand: 4,
      action: 'buy',
      label: 'getUrl()',
    };
    expect(sanitizeChartConfig({ chartType: 'BarChart', data: [row] }).data).toEqual([row]);
  });

  it('matches reserved names exactly, so differently cased columns are kept', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kept = { Style: 'bold', Ref: 'r1', Constructor: 'Acme', Prototype: 'v2' };
    const { data } = sanitizeChartConfig({
      chartType: 'BarChart',
      data: [{ ...kept, style: 'x', ref: 'y', dangerouslySetInnerHTML: 'z' }],
    });
    expect(data).toEqual([kept]);
    warn.mockRestore();
  });

  it('keeps only primitive values, plus nested Treemap children', () => {
    const { data } = sanitizeChartConfig({
      chartType: 'Treemap',
      data: [
        {
          name: 'root',
          one: 1,
          online: true,
          missing: null,
          meta: { __html: 'x' },
          list: ['a'],
          children: [{ name: 'leaf', size: 3, nested: { a: 1 } }],
        },
      ],
    });
    expect(data).toEqual([
      { name: 'root', one: 1, online: true, missing: null, children: [{ name: 'leaf', size: 3 }] },
    ]);
  });

  it('drops string values that would load a remote resource', () => {
    const { data } = sanitizeChartConfig({
      chartType: 'PieChart',
      data: [
        { name: 'a', value: 1, fill: 'url(https://example.com/x)' },
        { name: 'b', value: 2, fill: '#ff0000' },
      ],
    });
    expect(data).toEqual([
      { name: 'a', value: 1 },
      { name: 'b', value: 2, fill: '#ff0000' },
    ]);
  });

  it('warns once per column when a string value is dropped for a remote reference', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { data } = sanitizeChartConfig({
      chartType: 'BarChart',
      data: [
        { caption: '@import rules', n: 1 },
        { caption: 'see url(https://example.com/x)', n: 2 },
        { caption: 'plain', n: 3 },
      ],
    });
    expect(data).toEqual([{ n: 1 }, { n: 2 }, { caption: 'plain', n: 3 }]);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('"caption"'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('drops non-object rows and non-array data', () => {
    expect(sanitizeChartConfig({ chartType: 'BarChart', data: [1, 'x', null, { a: 1 }] }).data).toEqual([{ a: 1 }]);
    expect(sanitizeChartConfig({ chartType: 'BarChart', data: 'nope' }).data).toEqual([]);
  });

  const colorsOf = (colors: unknown[]) =>
    sanitizeChartConfig({ chartType: 'BarChart', config: { colors } }).config.colors;

  it('accepts var(), angle-unit color functions and in-document gradient references', () => {
    expect(colorsOf(['var(--brand)', 'hsl(210deg 50% 50%)', 'hsl(0.5turn 50% 50%)', 'url(#grad)'])).toEqual([
      'var(--brand)',
      'hsl(210deg 50% 50%)',
      'hsl(0.5turn 50% 50%)',
      'url(#grad)',
    ]);
  });

  it.each(['url(https://x)', 'var(--a, url(https://x))', 'url(#a) url(https://x)'])('rejects the color %s', value => {
    expect(colorsOf([value])).toEqual([DEFAULT_CHART_COLORS[0]]);
  });

  it('replaces an invalid color with the default at the same index instead of shifting', () => {
    expect(colorsOf(['#111', 'url(https://x)', '#333'])).toEqual(['#111', DEFAULT_CHART_COLORS[1], '#333']);
    expect(colorsOf([])).toBeUndefined();
  });

  it('allow-lists series props and colors', () => {
    const { config } = sanitizeChartConfig({
      chartType: 'ComposedChart',
      data: [{ a: 1 }],
      config: {
        colors: ['#8884d8', 'url(https://example.com/x)', 'rgb(1, 2, 3)', { toString: 'x' }],
        axes: { x: { dataKey: 'a', label: { value: 'x' } }, y: [{ dataKey: 'a', orientation: 'top' }] },
        children: [
          {
            type: 'Bar',
            dataKey: 'a',
            fill: 'url(https://example.com/x)',
            stroke: 'blue',
            barSize: 12,
            dangerouslySetInnerHTML: { __html: 'x' },
            label: { children: 'x' },
          },
          { type: 'Script', dataKey: 'a' },
        ],
      },
    });
    expect(config.colors).toEqual(['#8884d8', DEFAULT_CHART_COLORS[1], 'rgb(1, 2, 3)', DEFAULT_CHART_COLORS[3]]);
    expect(config.axes).toEqual({
      x: { dataKey: 'a', label: undefined },
      y: [{ dataKey: 'a', label: undefined, orientation: undefined }],
    });
    expect(config.children).toEqual([{ type: 'Bar', dataKey: 'a', stroke: 'blue', barSize: 12 }]);
  });
});
