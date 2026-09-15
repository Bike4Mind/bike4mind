/**
 * Shared validators for agent CRUD endpoints. Both POST `/api/agents` and
 * PUT `/api/agents/[id]` accept the same orchestration fields and must apply
 * identical bounds to prevent malformed callers writing unbounded blobs to
 * MongoDB (no schema-level cap on string-array length).
 */

import { BadRequestError } from '@bike4mind/utils';
import { triggerWordsSchema } from '@bike4mind/common';

// Mirrors `MAX_ITERATIONS_UPPER_BOUND` in `packages/database/src/models/AgentModel.ts`.
// Kept in sync so the API rejects out-of-range values before the Mongoose
// schema validator does - yields a 400 rather than a 500.
const MAX_ITERATIONS_UPPER_BOUND = 100;

const THOROUGHNESS_LEVELS = ['quick', 'medium', 'very_thorough'] as const;

type MaxIterationsByThoroughness = { quick: number; medium: number; very_thorough: number };

export function validateToolList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new BadRequestError(`${field} must be an array of strings`);
  }
  if (value.length > 100) {
    throw new BadRequestError(`${field} may contain at most 100 entries`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string') {
      throw new BadRequestError(`${field}[${i}] must be a string`);
    }
    if (entry.length > 256) {
      throw new BadRequestError(`${field}[${i}] exceeds 256-character limit`);
    }
    return entry;
  });
}

export function validateMaxIterations(value: unknown): MaxIterationsByThoroughness | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestError('maxIterations must be an object with quick/medium/very_thorough entries');
  }
  const record = value as Record<string, unknown>;
  for (const level of THOROUGHNESS_LEVELS) {
    const n = record[level];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_ITERATIONS_UPPER_BOUND) {
      throw new BadRequestError(
        `maxIterations.${level} must be an integer between 1 and ${MAX_ITERATIONS_UPPER_BOUND}`
      );
    }
  }
  return value as MaxIterationsByThoroughness;
}

export function validateDefaultThoroughness(value: unknown): (typeof THOROUGHNESS_LEVELS)[number] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !THOROUGHNESS_LEVELS.includes(value as (typeof THOROUGHNESS_LEVELS)[number])) {
    throw new BadRequestError(`defaultThoroughness must be one of: ${THOROUGHNESS_LEVELS.join(', ')}`);
  }
  return value as (typeof THOROUGHNESS_LEVELS)[number];
}

/**
 * Bounds-checked string-array validator for orchestration fields where the
 * entries are opaque identifiers (MCP server names, model ids, etc.). Same
 * 100/256 limits as `validateToolList` - the limits protect MongoDB from
 * malformed callers writing unbounded blobs.
 */
export function validateStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new BadRequestError(`${field} must be an array of strings`);
  }
  if (value.length > 100) {
    throw new BadRequestError(`${field} may contain at most 100 entries`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string') {
      throw new BadRequestError(`${field}[${i}] must be a string`);
    }
    if (entry.length > 256) {
      throw new BadRequestError(`${field}[${i}] exceeds 256-character limit`);
    }
    return entry;
  });
}

const DEFAULT_VARIABLES_MAX_ENTRIES = 50;
const DEFAULT_VARIABLES_MAX_KEY_LEN = 64;
const DEFAULT_VARIABLES_MAX_VALUE_LEN = 1024;

/**
 * Flat string-to-string record. Matches the AgentModel schema validator at
 * `packages/database/src/models/AgentModel.ts:376-385` - caps both entry count
 * and individual key/value length so a malformed caller can't write unbounded
 * blobs to MongoDB. Keys must be non-empty after trim (a `''` key would survive
 * the schema validator but break template lookups downstream).
 */
export function validateDefaultVariables(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('defaultVariables must be a flat object of string values');
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length > DEFAULT_VARIABLES_MAX_ENTRIES) {
    throw new BadRequestError(`defaultVariables may contain at most ${DEFAULT_VARIABLES_MAX_ENTRIES} entries`);
  }
  const out: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (!key.trim()) {
      throw new BadRequestError('defaultVariables keys must be non-empty');
    }
    if (key.length > DEFAULT_VARIABLES_MAX_KEY_LEN) {
      throw new BadRequestError(
        `defaultVariables key "${key}" exceeds ${DEFAULT_VARIABLES_MAX_KEY_LEN}-character limit`
      );
    }
    if (typeof v !== 'string') {
      throw new BadRequestError(`defaultVariables["${key}"] must be a string`);
    }
    if (v.length > DEFAULT_VARIABLES_MAX_VALUE_LEN) {
      throw new BadRequestError(
        `defaultVariables["${key}"] exceeds ${DEFAULT_VARIABLES_MAX_VALUE_LEN}-character limit`
      );
    }
    out[key] = v;
  }
  return out;
}

/**
 * Validate `triggerWords` against the shared GitHub-style handle rules.
 *
 * Why this gate exists: the chat-side mention parser only matches
 * `[a-zA-Z0-9_-]` handles (no leading/trailing hyphens). Any trigger word
 * the form lets through but the parser can't read becomes a silent routing
 * failure - the agent never gets attached and the user sees no error. The
 * `BadRequestError` thrown here surfaces the rule to the API caller and
 * the agent form so the trap can't be reached.
 */
export function validateTriggerWords(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const result = triggerWordsSchema.safeParse(value);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message ?? 'Invalid triggerWords');
  }
  return result.data;
}
