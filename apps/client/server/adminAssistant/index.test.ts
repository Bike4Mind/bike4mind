import { describe, it, expect } from 'vitest';
import {
  ADMIN_ASSISTANT_TOOL_NAMES,
  UNREGISTERED_ADMIN_ASSISTANT_TOOL_NAMES,
  isAdminAssistantToolName,
} from '@bike4mind/common';
import { ADMIN_EVAL_CASES } from '../../../../b4m-core/services/src/llm/evals/adminAssistant/cases';
import type { ToolDefinition } from '@bike4mind/services/llm/tools';
import { adminAssistantToolDefinitions } from './index';

// Every admin tool schema is sent on every admin assistant turn. Past this budget, merge related
// tools or move to deferred tool loading instead of raising the number.
const ADMIN_TOOL_SCHEMA_BUDGET_CHARS = 12_000;

describe('adminAssistantToolDefinitions', () => {
  it('returns no definitions for a non-admin', () => {
    expect(adminAssistantToolDefinitions({ isAdmin: false })).toEqual({});
    expect(adminAssistantToolDefinitions({ isAdmin: null })).toEqual({});
    expect(adminAssistantToolDefinitions({})).toEqual({});
  });

  it('every registered key is an admin assistant tool name', () => {
    const keys = Object.keys(adminAssistantToolDefinitions({ isAdmin: true }));
    expect(keys.every(isAdminAssistantToolName)).toBe(true);
  });

  it('registers exactly the declared tools that are not listed as unregistered', () => {
    const registered = Object.keys(adminAssistantToolDefinitions({ isAdmin: true })).sort();
    const expected = ADMIN_ASSISTANT_TOOL_NAMES.filter(
      n => !UNREGISTERED_ADMIN_ASSISTANT_TOOL_NAMES.includes(n)
    ).sort();
    expect(registered).toEqual(expected);
  });

  it('has an eval row for every registered tool', () => {
    const covered = new Set(ADMIN_EVAL_CASES.flatMap(c => c.expectTools ?? []));
    const missing = Object.keys(adminAssistantToolDefinitions({ isAdmin: true })).filter(n => !covered.has(n));
    expect(missing).toEqual([]);
  });

  it('keeps the serialized tool schemas within the per-turn budget', () => {
    // Building a schema never reads the context.
    const context = {} as Parameters<ToolDefinition['implementation']>[0];
    const definitions = Object.values(adminAssistantToolDefinitions({ isAdmin: true }));
    const totalChars = definitions.reduce(
      (sum, definition) => sum + JSON.stringify(definition.implementation(context).toolSchema).length,
      0
    );

    expect(definitions.length).toBeGreaterThan(0);
    expect(totalChars).toBeLessThanOrEqual(ADMIN_TOOL_SCHEMA_BUDGET_CHARS);
  });
});
