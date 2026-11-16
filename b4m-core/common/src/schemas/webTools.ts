import { z } from 'zod';

/**
 * Request/response schemas for the web search, web fetch and weather tool routes. The public
 * /api/v1/tools/* contracts (api-contract/contracts/webTools.contract.ts) and the SPA-internal
 * /api/tools/* routes validate with these same objects, so the two doors cannot accept different
 * bodies. Plain Zod (no `.openapi()`) so any runtime can import them.
 */
export const WebSearchToolRequestSchema = z.object({
  query: z.string().describe('The search query.'),
  num_results: z.number().int().min(1).max(10).optional().describe('How many results to return. Defaults to 3.'),
});

export type WebSearchToolRequest = z.infer<typeof WebSearchToolRequestSchema>;

export const WebFetchToolRequestSchema = z.object({
  url: z
    .url()
    .refine(value => /^https?:\/\//i.test(value), { error: 'URL must use http or https protocol' })
    .describe('The http or https page to read.'),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character offset to resume a long page from, as hinted at the end of a truncated result.'),
});

export type WebFetchToolRequest = z.infer<typeof WebFetchToolRequestSchema>;

export const WeatherToolRequestSchema = z.object({
  lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
  lon: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
  units: z.enum(['imperial', 'metric']).optional().describe('Temperature units. Defaults to `imperial`.'),
});

export type WeatherToolRequest = z.infer<typeof WeatherToolRequestSchema>;

/** The tool's output as one string, formatted for a language model to read. */
export const WebToolResultResponseSchema = z.object({
  result: z.string(),
});

export type WebToolResultResponse = z.infer<typeof WebToolResultResponseSchema>;
