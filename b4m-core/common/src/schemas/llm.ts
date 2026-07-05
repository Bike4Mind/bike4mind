import { z } from 'zod';

/**
 * Official B4M LLM tools.
 */
export const b4mLLMTools = z.enum([
  'dice_roll',
  'image_generation',
  'edit_image',
  'weather_info',
  'web_search',
  'web_fetch',
  'wolfram_alpha',
  'math_evaluate',
  'mermaid_chart',
  'current_datetime',
  'deep_research',
  'prompt_enhancement',
  'recharts',
  'edit_file',
  'blog_publish',
  'blog_edit',
  'blog_draft',
  // Time Machine & Night Sky tools
  'wikipedia_on_this_day',
  'moon_phase',
  'sunrise_sunset',
  'iss_tracker',
  'planet_visibility',
  // Knowledge base search
  'search_knowledge_base',
  // Chess engine
  'chess_engine',
  'retrieve_knowledge_content',
  // Agent delegation
  'delegate_to_agent',
  // OptiHashi optimization tools
  'optihashi_schedule',
  'optihashi_formulate',
  'optihashi_edit_problem',
  // Navigation tool
  'navigate_view',
  // Jupyter notebook generation
  'generate_jupyter_notebook',
  // Excel generation
  'excel_generation',
  // Financial data
  'fmp_financial_data',
  // User-defined skills - LLM-invocable instruction templates
  'skill',
]);
export type B4MLLMTools = z.infer<typeof b4mLLMTools>;

export const B4MLLMToolsList = b4mLLMTools.options.map(tool => tool);

/**
 * Tool names implemented by premium overlay packages rather than by the core
 * tool registry. Implementations reach the chat pipeline at runtime via the
 * `externalTools` merge (premium glue codegen); core ships no implementation.
 * The names stay in b4mLLMTools for now so persisted session settings and
 * briefcase prompts that reference them keep parsing - the boundary cleanup
 * sweep removes them from the enum together with this type.
 */
export type PremiumOverlayToolName = Extract<
  B4MLLMTools,
  'optihashi_schedule' | 'optihashi_formulate' | 'optihashi_edit_problem'
>;

/**
 * Recharts chart types.
 */

export const RechartsChartTypeSchema = z.enum([
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
export type RechartsChartType = z.infer<typeof RechartsChartTypeSchema>;

export const RechartsChartTypeList = RechartsChartTypeSchema.enum;

/**
 * Schema for LLM model fallback information
 */
export const FallbackInfoSchema = z.object({
  sessionId: z.string(),
  primaryModel: z.string(),
  primaryModelName: z.string(),
  fallbackModel: z.string(),
  fallbackModelName: z.string(),
  timestamp: z.number(),
});

export type FallbackInfo = z.infer<typeof FallbackInfoSchema>;
