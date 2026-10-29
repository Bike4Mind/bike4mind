import { describe, it, expect } from 'vitest';
import { isAdminAssistantToolName } from '@bike4mind/common';
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
