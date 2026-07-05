import { jsonrepair } from 'jsonrepair';
import { ZodError } from 'zod';
import {
  RechartsConfigSchema,
  RechartsArtifactWrapperSchema,
  type RechartsConfig,
  type RechartsArtifactWrapper,
} from './chartSchemas';

/**
 * Error types for chart JSON parsing
 */
export type ChartParseErrorType = 'REPAIR_FAILED' | 'INVALID_JSON' | 'SCHEMA_MISMATCH' | 'EMPTY_INPUT';

export class ChartParseError extends Error {
  constructor(
    public readonly type: ChartParseErrorType,
    message: string,
    public readonly rawContent?: string,
    public readonly zodErrors?: ZodError
  ) {
    super(message);
    this.name = 'ChartParseError';
  }
}

/**
 * Security: Sanitize dangerous keys to prevent prototype pollution
 * Removes __proto__, constructor, and prototype keys from parsed objects
 */
function sanitizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    const clean: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Skip dangerous keys that could enable prototype pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      clean[key] = sanitizeKeys(value);
    }
    return clean;
  }
  return obj;
}

/**
 * Extracts JSON from text that may contain surrounding content
 * Handles markdown code blocks and text before/after JSON
 */
function extractJSONFromText(text: string): string | null {
  const trimmed = text.trim();

  // Try direct parse first (cleanest case)
  // Skip if content contains code fence markers - indicates concatenated blocks (e.g. }``````recharts{)
  if (
    !trimmed.includes('```') &&
    ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))
  ) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Fall through to extraction logic
    }
  }

  // Strip markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockMatch = trimmed.match(/```(?:json|recharts)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      // Try to repair it
      return inner;
    }
  }

  // Find first { or [ and match to corresponding closing bracket
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');

  if (objectStart === -1 && arrayStart === -1) return null;

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (objectStart === -1) {
    start = arrayStart;
    openChar = '[';
    closeChar = ']';
  } else if (arrayStart === -1) {
    start = objectStart;
    openChar = '{';
    closeChar = '}';
  } else {
    // Use whichever comes first
    if (objectStart < arrayStart) {
      start = objectStart;
      openChar = '{';
      closeChar = '}';
    } else {
      start = arrayStart;
      openChar = '[';
      closeChar = ']';
    }
  }

  // Find matching closing bracket using bracket counting
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  // If we didn't find a complete JSON, return from start to end for repair
  return trimmed.slice(start);
}

/**
 * Attempts to repair and parse JSON from potentially malformed LLM output
 *
 * Handles common LLM output issues:
 * - Trailing text after JSON (explanations, notes)
 * - Leading text before JSON
 * - Truncated JSON (auto-closes brackets)
 * - Single quotes instead of double quotes
 * - Trailing commas
 * - Missing commas between elements
 * - Unescaped characters
 * - Markdown code blocks
 *
 * @param rawContent - Raw string content from LLM that may contain chart JSON
 * @returns Parsed and validated RechartsConfig
 * @throws ChartParseError with specific error type and context
 */
export function parseChartJSON(rawContent: string): RechartsConfig {
  if (!rawContent || typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    throw new ChartParseError('EMPTY_INPUT', 'Chart data is empty or invalid', rawContent);
  }

  let repaired: string;
  let parsed: unknown;

  // Step 1: Extract JSON from text (handles leading/trailing content)
  const extracted = extractJSONFromText(rawContent);
  const jsonCandidate = extracted || rawContent;

  // Step 2: Attempt to repair the JSON
  try {
    repaired = jsonrepair(jsonCandidate);
  } catch (repairError) {
    throw new ChartParseError(
      'REPAIR_FAILED',
      `Could not extract valid JSON from chart data: ${repairError instanceof Error ? repairError.message : 'Unknown error'}`,
      rawContent
    );
  }

  // Step 3: Parse the repaired JSON
  try {
    parsed = JSON.parse(repaired);
  } catch (parseError) {
    throw new ChartParseError(
      'INVALID_JSON',
      `JSON parsing failed after repair: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
      rawContent
    );
  }

  // Step 4: Sanitize to prevent prototype pollution
  const sanitized = sanitizeKeys(parsed);

  // Step 5: Check if this is an artifact wrapper and unwrap if needed
  const unwrapped = unwrapArtifact(sanitized);

  // Step 6: Validate against schema
  const validationResult = RechartsConfigSchema.safeParse(unwrapped);

  if (!validationResult.success) {
    const errorMessages = validationResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');

    throw new ChartParseError(
      'SCHEMA_MISMATCH',
      `Invalid chart configuration: ${errorMessages}`,
      rawContent,
      validationResult.error
    );
  }

  return validationResult.data;
}

/**
 * Unwrap artifact envelope if present
 * LLM may return chart config wrapped in { type: 'recharts', content: {...} }
 */
function unwrapArtifact(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const maybeWrapper = obj as Record<string, unknown>;

  // Check if this matches the artifact wrapper pattern
  if (maybeWrapper.type === 'recharts' && maybeWrapper.content !== undefined) {
    // Validate wrapper structure
    const wrapperResult = RechartsArtifactWrapperSchema.safeParse(maybeWrapper);

    if (wrapperResult.success) {
      const wrapper = wrapperResult.data as RechartsArtifactWrapper;
      let innerContent: unknown = wrapper.content;

      // If content is a string, parse it
      if (typeof innerContent === 'string') {
        try {
          const repairedInner = jsonrepair(innerContent);
          innerContent = sanitizeKeys(JSON.parse(repairedInner));
        } catch {
          // If parsing fails, return as-is for schema validation to handle
          return wrapper.content;
        }
      }

      // Merge metadata title/description into config if present
      if (wrapper.metadata && typeof innerContent === 'object' && innerContent !== null) {
        const config = innerContent as Record<string, unknown>;
        if (wrapper.metadata.title && !config.title) {
          config.title = wrapper.metadata.title;
        }
        if (wrapper.metadata.description && !config.description) {
          config.description = wrapper.metadata.description;
        }
      }

      return innerContent;
    }
  }

  // Check if it already has chartType and data (direct config, not wrapped)
  if (maybeWrapper.chartType !== undefined && maybeWrapper.data !== undefined) {
    return obj;
  }

  return obj;
}

/**
 * Safe wrapper that returns null instead of throwing
 * Useful for fallback scenarios
 */
export function tryParseChartJSON(rawContent: string): RechartsConfig | null {
  try {
    return parseChartJSON(rawContent);
  } catch {
    return null;
  }
}

/**
 * Get user-friendly error message for display
 */
export function getChartErrorMessage(error: ChartParseError): string {
  switch (error.type) {
    case 'EMPTY_INPUT':
      return 'No chart data received. Try regenerating the response.';
    case 'REPAIR_FAILED':
      return 'Could not find valid chart data in the response. Try regenerating.';
    case 'INVALID_JSON':
      return 'The chart data was malformed. Try regenerating.';
    case 'SCHEMA_MISMATCH':
      return 'The chart data structure was unexpected. Check the chart type and data format.';
    default:
      return 'An error occurred while processing the chart. Try regenerating.';
  }
}
