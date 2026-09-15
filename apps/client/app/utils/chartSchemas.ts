import { z } from 'zod';

/**
 * Schema for chart axis configuration in ComposedChart
 */
export const ChartAxisConfigSchema = z.object({
  dataKey: z.string(),
  label: z.string().optional(),
  orientation: z.enum(['left', 'right']).optional(),
});

/**
 * Schema for ComposedChart children (Bar, Line, Area components)
 */
export const ChartChildSchema = z.object({
  type: z.enum(['Bar', 'Line', 'Area']),
  dataKey: z.string(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  name: z.string().optional(),
});

/**
 * Schema for chart configuration options
 */
export const ChartConfigOptionsSchema = z.object({
  xAxis: z.string().optional(),
  yAxis: z.union([z.string(), z.array(z.string())]).optional(),
  width: z.number().min(100).max(2000).optional(),
  height: z.number().min(100).max(1500).optional(),
  colors: z.array(z.string()).optional(),
  legend: z.boolean().optional(),
  grid: z.boolean().optional(),
  tooltip: z.boolean().optional(),
  responsive: z.boolean().optional(),
  // ComposedChart specific configuration
  axes: z
    .object({
      x: z.object({ dataKey: z.string(), label: z.string().optional() }).optional(),
      y: z.array(ChartAxisConfigSchema).optional(),
    })
    .optional(),
  children: z.array(ChartChildSchema).optional(),
});

/**
 * Valid chart types matching RechartsChartTypeSchema from @bike4mind/common
 */
export const ChartTypeSchema = z.enum([
  'LineChart',
  'AreaChart',
  'BarChart',
  'PieChart',
  'ScatterChart',
  'RadialBarChart',
  'ComposedChart',
  'Treemap',
  'FunnelChart',
  'RadarChart',
]);

/**
 * Main schema for Recharts configuration
 * Used to validate chart data parsed from LLM responses
 */
export const RechartsConfigSchema = z.object({
  chartType: ChartTypeSchema,
  data: z.array(z.record(z.string(), z.unknown())).min(1, 'Chart must have at least one data point'),
  config: ChartConfigOptionsSchema.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});

export type RechartsConfig = z.infer<typeof RechartsConfigSchema>;
export type ChartConfigOptions = z.infer<typeof ChartConfigOptionsSchema>;
export type ChartType = z.infer<typeof ChartTypeSchema>;

/**
 * Schema for the artifact wrapper structure
 * LLM may wrap chart config in an artifact envelope
 */
export const RechartsArtifactWrapperSchema = z.object({
  type: z.literal('recharts'),
  content: z.union([z.string(), RechartsConfigSchema]),
  metadata: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});

export type RechartsArtifactWrapper = z.infer<typeof RechartsArtifactWrapperSchema>;
