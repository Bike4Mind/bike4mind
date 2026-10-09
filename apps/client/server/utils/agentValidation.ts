/**
 * Shared validators for agent CRUD endpoints. Both POST `/api/agents` and
 * PUT `/api/agents/[id]` accept the same orchestration fields and must apply
 * identical bounds to prevent malformed callers writing unbounded blobs to
 * MongoDB (no schema-level cap on string-array length).
 */

import { BadRequestError } from '@bike4mind/utils';
import { IAgent, supportedChatModels, supportedImageModels, triggerWordsSchema } from '@bike4mind/common';

/**
 * A body field failed one of these validators. A BadRequestError (400) on the SPA routes; the
 * /api/v1 routes remap exactly this class to a 422 (server/agents/v1AgentErrors.ts), so any other
 * 400 a shared helper throws keeps its status.
 */
export class AgentValidationError extends BadRequestError {}

// Mirrors `MAX_ITERATIONS_UPPER_BOUND` in `packages/database/src/models/AgentModel.ts`.
// Kept in sync so the API rejects out-of-range values before the Mongoose
// schema validator does - yields a 400 rather than a 500.
const MAX_ITERATIONS_UPPER_BOUND = 100;

const THOROUGHNESS_LEVELS = ['quick', 'medium', 'very_thorough'] as const;

type MaxIterationsByThoroughness = { quick: number; medium: number; very_thorough: number };

export function validateToolList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AgentValidationError(`${field} must be an array of strings`);
  }
  if (value.length > 100) {
    throw new AgentValidationError(`${field} may contain at most 100 entries`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string') {
      throw new AgentValidationError(`${field}[${i}] must be a string`);
    }
    if (entry.length > 256) {
      throw new AgentValidationError(`${field}[${i}] exceeds 256-character limit`);
    }
    return entry;
  });
}

export function validateMaxIterations(value: unknown): MaxIterationsByThoroughness | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentValidationError('maxIterations must be an object with quick/medium/very_thorough entries');
  }
  const record = value as Record<string, unknown>;
  for (const level of THOROUGHNESS_LEVELS) {
    const n = record[level];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_ITERATIONS_UPPER_BOUND) {
      throw new AgentValidationError(
        `maxIterations.${level} must be an integer between 1 and ${MAX_ITERATIONS_UPPER_BOUND}`
      );
    }
  }
  return value as MaxIterationsByThoroughness;
}

export function validateDefaultThoroughness(value: unknown): (typeof THOROUGHNESS_LEVELS)[number] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !THOROUGHNESS_LEVELS.includes(value as (typeof THOROUGHNESS_LEVELS)[number])) {
    throw new AgentValidationError(`defaultThoroughness must be one of: ${THOROUGHNESS_LEVELS.join(', ')}`);
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
    throw new AgentValidationError(`${field} must be an array of strings`);
  }
  if (value.length > 100) {
    throw new AgentValidationError(`${field} may contain at most 100 entries`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string') {
      throw new AgentValidationError(`${field}[${i}] must be a string`);
    }
    if (entry.length > 256) {
      throw new AgentValidationError(`${field}[${i}] exceeds 256-character limit`);
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
    throw new AgentValidationError('defaultVariables must be a flat object of string values');
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length > DEFAULT_VARIABLES_MAX_ENTRIES) {
    throw new AgentValidationError(`defaultVariables may contain at most ${DEFAULT_VARIABLES_MAX_ENTRIES} entries`);
  }
  const out: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (!key.trim()) {
      throw new AgentValidationError('defaultVariables keys must be non-empty');
    }
    if (key.length > DEFAULT_VARIABLES_MAX_KEY_LEN) {
      throw new AgentValidationError(
        `defaultVariables key "${key}" exceeds ${DEFAULT_VARIABLES_MAX_KEY_LEN}-character limit`
      );
    }
    if (typeof v !== 'string') {
      throw new AgentValidationError(`defaultVariables["${key}"] must be a string`);
    }
    if (v.length > DEFAULT_VARIABLES_MAX_VALUE_LEN) {
      throw new AgentValidationError(
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
    throw new AgentValidationError(result.error.issues[0]?.message ?? 'Invalid triggerWords');
  }
  return result.data;
}

/**
 * Validates and normalizes the fields of an agent update in place, for PUT /api/agents/[id] and
 * PATCH /api/v1/agents/[id]. Only fields present on `agentData` are checked. `label` renames a field
 * in an error message, so the v1 route can name its snake_case spelling.
 */
export function validateAgentUpdate(agentData: Partial<IAgent>, label: (field: string) => string = field => field) {
  if (agentData.preferredModel && !supportedChatModels.safeParse(agentData.preferredModel).success) {
    throw new AgentValidationError(`Invalid model: ${agentData.preferredModel}`);
  }
  if (agentData.preferredImageModel && !supportedImageModels.safeParse(agentData.preferredImageModel).success) {
    throw new AgentValidationError(`Invalid image model: ${agentData.preferredImageModel}`);
  }
  if (agentData.temperature !== undefined && (agentData.temperature < 0 || agentData.temperature > 2)) {
    throw new AgentValidationError('Temperature must be between 0 and 2');
  }
  if (agentData.maxTokens !== undefined && (agentData.maxTokens < 1 || agentData.maxTokens > 128000)) {
    throw new AgentValidationError('Max tokens must be between 1 and 128000');
  }

  // Reject malformed trigger words before they reach MongoDB - keeps updates in sync with create
  // and stops a silent regression where a valid create is followed by a malformed edit.
  if (agentData.triggerWords !== undefined) {
    agentData.triggerWords = validateTriggerWords(agentData.triggerWords);
  }

  // Orchestration fields - mirror the create bounds so an update can't bypass the array-size /
  // max-iteration guards.
  if (agentData.allowedTools !== undefined) {
    agentData.allowedTools = validateToolList(agentData.allowedTools, label('allowedTools'));
  }
  if (agentData.deniedTools !== undefined) {
    agentData.deniedTools = validateToolList(agentData.deniedTools, label('deniedTools'));
  }
  if (agentData.maxIterations !== undefined) {
    agentData.maxIterations = validateMaxIterations(agentData.maxIterations);
  }
  if (agentData.defaultThoroughness !== undefined) {
    agentData.defaultThoroughness = validateDefaultThoroughness(agentData.defaultThoroughness);
  }
  if (agentData.defaultVariables !== undefined) {
    agentData.defaultVariables = validateDefaultVariables(agentData.defaultVariables);
  }
  if (agentData.exclusiveMcpServers !== undefined) {
    agentData.exclusiveMcpServers = validateStringList(agentData.exclusiveMcpServers, 'exclusiveMcpServers');
  }
  if (agentData.fallbackModels !== undefined) {
    agentData.fallbackModels = validateStringList(agentData.fallbackModels, 'fallbackModels');
  }
}
