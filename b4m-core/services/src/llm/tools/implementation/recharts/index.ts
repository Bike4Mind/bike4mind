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
      description: `ALWAYS use this tool when the user asks for ANY chart, graph, or data visualization.
      
      PURPOSE:
      - This tool creates interactive charts using the Recharts React library.
      - Charts are always returned as <artifact> blocks that render in the user interface.
      - DO NOT generate images (PNG, JPG, SVG, base64, or URLs). The ONLY valid way to produce charts is by invoking this tool.

      MANDATORY USAGE FOR:
      - Any request containing words: chart, graph, plot, visualization, bar chart, line chart, pie chart, scatter plot, area chart
      - When the user says "show data", "visualize", "create a chart", "make a graph"
      - Any request to display data visually or compare data points
      - Dashboard-style data presentations or analytics displays

      CAPABILITIES:
      - Supports multiple chart types but not limited to: bar, line, area, pie, scatter, composed charts
      - Generates responsive charts with tooltips, legends, and grid lines
      - Returns properly formatted artifacts for frontend rendering
      - Handles data validation and chart configuration

      CRITICAL USAGE RULES - YOU MUST FOLLOW THESE:
      1. ⚠️ MANDATORY: You MUST provide the "data" parameter with actual chart data as an array of objects. DO NOT call this tool without data. Example: [{"stage": "Awareness", "count": 10000}, {"stage": "Interest", "count": 5000}]
      2. ⚠️ MANDATORY: You MUST specify the "yAxis" parameter with the field name for values (e.g., "count", "value", "revenue")
      3. For FunnelChart and PieChart: MUST specify both xAxis (label field) and yAxis (value field)
      4. You MUST generate or use real numerical data - never call the tool expecting it to generate data for you
      5. ALWAYS return charts as artifacts, never as images
      6. Use the complete <artifact> output returned by this tool without modification
      7. Never create React components manually - always use this tool for charts
      8. Add a brief explanation AFTER the tool output to help users understand the visualization
      9. NEVER return inline SVG, PNG, or other image renderings of charts. Only artifacts.
      
      EXAMPLE 1 — Single series:
      {
        "data": [{"month": "Jan", "sales": 4000}, {"month": "Feb", "sales": 3000}, {"month": "Mar", "sales": 5000}],
        "chartType": "LineChart",
        "xAxis": "month",
        "yAxis": "sales",
        "title": "Monthly Sales"
      }

      EXAMPLE 2 — Multiple series (yAxis as array):
      {
        "data": [{"month": "Jan", "revenue": 4000, "profit": 1200}, {"month": "Feb", "revenue": 3000, "profit": 900}, {"month": "Mar", "revenue": 5000, "profit": 1800}],
        "chartType": "LineChart",
        "xAxis": "month",
        "yAxis": ["revenue", "profit"],
        "title": "Revenue vs Profit"
      }`,
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            description:
              '⚠️ ABSOLUTELY REQUIRED - YOU MUST PROVIDE THIS: Array of data objects with actual numerical values for the chart. Each object must have keys corresponding to chart axes/values. DO NOT call this tool without providing data. You must generate or provide real data values. Example: [{"stage": "Awareness", "count": 10000}, {"stage": "Interest", "count": 5000}, {"stage": "Purchase", "count": 1000}] or [{"month": "Jan", "sales": 4000}, {"month": "Feb", "sales": 3000}].',
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
              'Key from data objects to use for X-axis or labels. REQUIRED for: LineChart, BarChart, AreaChart. For PieChart: use for slice labels (nameKey). For FunnelChart: use for stage labels.',
          },
          yAxis: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description:
              'REQUIRED: Key(s) from data objects to use for Y-axis values. Pass a single string for one series (e.g. "sales") or an ARRAY of strings for multiple series (e.g. ["revenue", "profit"]). For PieChart/FunnelChart: must be a single string for the value field like "count" or "value". ALWAYS specify this parameter.',
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
