import { RechartsChartType, RechartsChartTypeList } from '@bike4mind/common';
import { ToolDefinition } from '../../base/types';

interface RechartsParams {
  data: Array<Record<string, any>>;
  chartType: RechartsChartType;
  xAxis?: string;
  yAxis?: string | string[];
  title?: string;
  description?: string;
  width?: number;
  height?: number;
  colors?: string[];
  legend?: boolean;
  grid?: boolean;
  tooltip?: boolean;
  responsive?: boolean;
}

const executeRechartsGeneration = async (parameters: RechartsParams): Promise<string> => {
  if (!parameters.chartType) {
    throw new Error('Tool recharts: Missing required parameter "chartType"');
  }
  const chartData = parameters.data;

  // Validate that data is provided and not empty
  if (!chartData || chartData.length === 0) {
    throw new Error(
      'Tool recharts: Missing required parameter "data". Chart data must be provided as an array of objects.'
    );
  }

  // Validate chart type
  const validChartTypes = Object.values(RechartsChartTypeList);

  if (!validChartTypes.includes(parameters.chartType)) {
    throw new Error(
      `Tool recharts: Invalid chartType "${parameters.chartType}". Must be one of: ${validChartTypes.join(', ')}`
    );
  }

  // Validate dimensions if provided
  if (parameters.width !== undefined && (parameters.width < 200 || parameters.width > 1200)) {
    throw new Error('Tool recharts: Width must be between 200 and 1200 pixels');
  }

  if (parameters.height !== undefined && (parameters.height < 200 || parameters.height > 800)) {
    throw new Error('Tool recharts: Height must be between 200 and 800 pixels');
  }

  // Generate chart configuration - return format matches what client expects
  const chartConfig = {
    chartType: parameters.chartType,
    data: chartData,
    config: {
      xAxis: parameters.xAxis,
      yAxis: parameters.yAxis,
      width: parameters.width || 600,
      height: parameters.height || 400,
      colors: parameters.colors || ['#8884d8', '#82ca9d', '#ffc658', '#ff7c7c', '#8dd1e1'],
      legend: parameters.legend !== false,
      grid: parameters.grid !== false,
      tooltip: parameters.tooltip !== false,
      responsive: parameters.responsive !== false,
    },
  };

  // Always return as artifact - client-side handles display mode based on user preferences

  // Important: content should be the object itself, not a stringified version
  // It will be stringified once when we stringify the entire artifactData
  const artifactData = {
    type: 'recharts',
    content: chartConfig,
    metadata: {
      title: parameters.title || 'Chart',
      description: parameters.description || '',
      chartType: parameters.chartType,
      dataPoints: chartData?.length,
    },
  };

  return `Here's the chart you requested:

<artifact identifier="chart-${Date.now()}" type="application/vnd.ant.recharts" title="${parameters.title || 'Chart'}">
${JSON.stringify(artifactData, null, 2)}
</artifact>`;
};

export const rechartsTool: ToolDefinition = {
  name: 'recharts',
  implementation: context => ({
    toolFn: async value => {
      const params = value as RechartsParams;
      try {
        const result = await executeRechartsGeneration(params);
        return result;
      } catch (error) {
        context.logger.error('❌ Recharts: Chart generation failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'recharts',
      description: `Create an interactive chart. Use for any request for a chart, graph, plot or data visualization ("show data", "visualize", "compare ..."), and for dashboard-style or analytics displays.

This is the ONLY valid way to produce a chart. Never emit an image (PNG/JPG/SVG/base64/URL) or a hand-written React component.

Rules:
- Supply "data" yourself as an array of objects holding real NUMERIC values. The tool does not generate data; calling without it fails. Nothing validates the value types, so a quoted number like "4,000" renders as garbage.
- "yAxis" is the value field: a string, or an array of strings for multiple series. PieChart/FunnelChart take a single string.
- "xAxis" is the label field. Required for LineChart/BarChart/AreaChart, and for PieChart/FunnelChart too, where it labels the slices/stages.
- Return the <artifact> output unmodified, then add a brief explanation of what it shows.

Example:
{"data":[{"month":"Jan","revenue":4000,"profit":1200},{"month":"Feb","revenue":3000,"profit":900}],"chartType":"LineChart","xAxis":"month","yAxis":["revenue","profit"],"title":"Revenue vs Profit"}`,
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            description:
              'Required. Array of data objects holding the real values to plot, keyed by the axis/value field names. Example: [{"month":"Jan","sales":4000},{"month":"Feb","sales":3000}].',
            items: {
              type: 'object',
            },
          },
          chartType: {
            type: 'string',
            description: 'The type of Recharts chart to generate',
            enum: Object.values(RechartsChartTypeList),
          },
          xAxis: {
            type: 'string',
            description:
              'Label field. Needed for LineChart/BarChart/AreaChart, and for PieChart/FunnelChart where it labels the slices/stages.',
          },
          yAxis: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description:
              'Required. Value field: a string for one series, or an array of strings for several. PieChart and FunnelChart take a single string.',
          },
          title: {
            type: 'string',
            description: 'Optional title for the chart',
          },
          description: {
            type: 'string',
            description: 'Optional description of what the chart represents',
          },
          width: {
            type: 'number',
            description: 'Width of the chart in pixels (default: 600)',
            minimum: 200,
            maximum: 1200,
          },
          height: {
            type: 'number',
            description: 'Height of the chart in pixels (default: 400)',
            minimum: 200,
            maximum: 800,
          },
          colors: {
            type: 'array',
            description: 'Array of color codes for chart elements (default: predefined palette)',
            items: {
              type: 'string',
              pattern: '^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$',
            },
          },
          legend: {
            type: 'boolean',
            description: 'Whether to show legend (default: true)',
          },
          grid: {
            type: 'boolean',
            description: 'Whether to show grid lines (default: true)',
          },
          tooltip: {
            type: 'boolean',
            description: 'Whether to show tooltips on hover (default: true)',
          },
          responsive: {
            type: 'boolean',
            description: 'Whether the chart should be responsive (default: true)',
          },
        },
        required: ['data', 'chartType', 'yAxis'],
      },
    },
  }),
};
