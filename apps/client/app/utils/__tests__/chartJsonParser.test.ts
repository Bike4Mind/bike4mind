import { describe, it, expect } from 'vitest';
import { parseChartJSON, tryParseChartJSON, ChartParseError, getChartErrorMessage } from '../chartJsonParser';

describe('chartJsonParser', () => {
  describe('parseChartJSON', () => {
    it('should parse valid JSON chart config', () => {
      const input = JSON.stringify({
        chartType: 'BarChart',
        data: [{ name: 'A', value: 100 }],
      });

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('BarChart');
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({ name: 'A', value: 100 });
    });

    it('should handle JSON with trailing explanatory text', () => {
      const input = `{
        "chartType": "LineChart",
        "data": [{"x": 1, "y": 10}, {"x": 2, "y": 20}]
      }

      This chart shows the growth trend over time. As you can see, values increase linearly.`;

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('LineChart');
      expect(result.data).toHaveLength(2);
    });

    it('should handle JSON with leading explanatory text', () => {
      const input = `Here's the chart data you requested:

      {
        "chartType": "PieChart",
        "data": [{"name": "A", "value": 30}, {"name": "B", "value": 70}]
      }`;

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('PieChart');
      expect(result.data).toHaveLength(2);
    });

    it('should handle truncated JSON by auto-closing brackets', () => {
      // jsonrepair will attempt to close the brackets
      const input = `{"chartType": "BarChart", "data": [{"name": "A", "value": 100}`;

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('BarChart');
    });

    it('should handle single quotes instead of double quotes', () => {
      const input = `{'chartType': 'AreaChart', 'data': [{'name': 'Test', 'value': 50}]}`;

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('AreaChart');
    });

    it('should handle trailing commas', () => {
      const input = `{
        "chartType": "ScatterChart",
        "data": [
          {"x": 1, "y": 10},
          {"x": 2, "y": 20},
        ],
      }`;

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('ScatterChart');
      expect(result.data).toHaveLength(2);
    });

    it('should unwrap artifact envelope format', () => {
      const input = JSON.stringify({
        type: 'recharts',
        content: {
          chartType: 'ComposedChart',
          data: [{ name: 'Item', bar: 10, line: 5 }],
        },
        metadata: {
          title: 'My Chart',
          description: 'A test chart',
        },
      });

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('ComposedChart');
      expect(result.title).toBe('My Chart');
      expect(result.description).toBe('A test chart');
    });

    it('should unwrap artifact envelope with stringified content', () => {
      const input = JSON.stringify({
        type: 'recharts',
        content: JSON.stringify({
          chartType: 'RadarChart',
          data: [{ name: 'A', value: 100 }],
        }),
        metadata: {
          title: 'Radar Analysis',
        },
      });

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('RadarChart');
      expect(result.title).toBe('Radar Analysis');
    });

    it('should strip dangerous prototype pollution keys', () => {
      const input = JSON.stringify({
        chartType: 'BarChart',
        data: [{ name: 'A', value: 100 }],
        __proto__: { malicious: true },
        constructor: { evil: 'code' },
      });

      const result = parseChartJSON(input);

      // Verify chart parsed correctly
      expect(result.chartType).toBe('BarChart');
      expect(result.data).toHaveLength(1);

      // Verify the malicious content was stripped from the result
      // The keys should not exist as own enumerable properties
      const keys = Object.keys(result);
      expect(keys).not.toContain('__proto__');
      expect(keys).not.toContain('constructor');
      expect(keys).not.toContain('prototype');
    });

    it('should throw ChartParseError for empty input', () => {
      expect(() => parseChartJSON('')).toThrow(ChartParseError);
      expect(() => parseChartJSON('   ')).toThrow(ChartParseError);
    });

    it('should throw ChartParseError for completely invalid input', () => {
      expect(() => parseChartJSON('not json at all')).toThrow(ChartParseError);
    });

    it('should throw ChartParseError for valid JSON with missing required fields', () => {
      const input = JSON.stringify({
        chartType: 'BarChart',
        // missing 'data' field
      });

      expect(() => parseChartJSON(input)).toThrow(ChartParseError);
    });

    it('should throw ChartParseError for invalid chartType', () => {
      const input = JSON.stringify({
        chartType: 'InvalidChartType',
        data: [{ name: 'A', value: 100 }],
      });

      expect(() => parseChartJSON(input)).toThrow(ChartParseError);
    });

    it('should throw ChartParseError for empty data array', () => {
      const input = JSON.stringify({
        chartType: 'BarChart',
        data: [],
      });

      expect(() => parseChartJSON(input)).toThrow(ChartParseError);
    });

    it('should include correct error type in ChartParseError', () => {
      try {
        parseChartJSON('');
      } catch (error) {
        expect(error).toBeInstanceOf(ChartParseError);
        expect((error as ChartParseError).type).toBe('EMPTY_INPUT');
      }

      try {
        parseChartJSON('{"chartType": "InvalidType", "data": [{}]}');
      } catch (error) {
        expect(error).toBeInstanceOf(ChartParseError);
        expect((error as ChartParseError).type).toBe('SCHEMA_MISMATCH');
      }
    });
  });

  describe('tryParseChartJSON', () => {
    it('should return parsed config for valid input', () => {
      const input = JSON.stringify({
        chartType: 'BarChart',
        data: [{ name: 'A', value: 100 }],
      });

      const result = tryParseChartJSON(input);

      expect(result).not.toBeNull();
      expect(result?.chartType).toBe('BarChart');
    });

    it('should return null for invalid input instead of throwing', () => {
      expect(tryParseChartJSON('')).toBeNull();
      expect(tryParseChartJSON('not json')).toBeNull();
      expect(tryParseChartJSON('{"chartType": "Invalid", "data": []}')).toBeNull();
    });
  });

  describe('getChartErrorMessage', () => {
    it('should return user-friendly message for EMPTY_INPUT', () => {
      const error = new ChartParseError('EMPTY_INPUT', 'test');
      expect(getChartErrorMessage(error)).toContain('No chart data');
    });

    it('should return user-friendly message for REPAIR_FAILED', () => {
      const error = new ChartParseError('REPAIR_FAILED', 'test');
      expect(getChartErrorMessage(error)).toContain('Could not find valid chart data');
    });

    it('should return user-friendly message for INVALID_JSON', () => {
      const error = new ChartParseError('INVALID_JSON', 'test');
      expect(getChartErrorMessage(error)).toContain('malformed');
    });

    it('should return user-friendly message for SCHEMA_MISMATCH', () => {
      const error = new ChartParseError('SCHEMA_MISMATCH', 'test');
      expect(getChartErrorMessage(error)).toContain('structure was unexpected');
    });
  });

  describe('real-world LLM output scenarios', () => {
    it('should handle math explanation followed by chart data', () => {
      const input = `Based on the physics calculations for projectile motion:

The trajectory follows a parabolic path described by y = x*tan(θ) - (g*x²)/(2*v₀²*cos²(θ))

Here is the visualization:

{
  "chartType": "LineChart",
  "data": [
    {"x": 0, "y": 0},
    {"x": 10, "y": 8.66},
    {"x": 20, "y": 13.86},
    {"x": 30, "y": 15.59},
    {"x": 40, "y": 13.86},
    {"x": 50, "y": 8.66},
    {"x": 60, "y": 0}
  ],
  "config": {
    "xAxis": "x",
    "yAxis": "y"
  },
  "title": "Projectile Motion Trajectory"
}

The maximum height is reached at x = 30m, with a total range of 60m.`;

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('LineChart');
      expect(result.data).toHaveLength(7);
      expect(result.title).toBe('Projectile Motion Trajectory');
    });

    it('should handle markdown code block wrapper', () => {
      const input = `\`\`\`json
{
  "chartType": "BarChart",
  "data": [
    {"category": "Q1", "sales": 1200},
    {"category": "Q2", "sales": 1800},
    {"category": "Q3", "sales": 2400},
    {"category": "Q4", "sales": 3000}
  ]
}
\`\`\``;

      const result = parseChartJSON(input);

      expect(result.chartType).toBe('BarChart');
      expect(result.data).toHaveLength(4);
    });
  });
});
