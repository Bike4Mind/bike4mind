import { describe, it, expect } from 'vitest';
import { isAdminAssistantToolName } from '@bike4mind/common';
import { adminAssistantToolDefinitions } from './index';

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
});
