import { describe, it, expect } from 'vitest';
import { TOOL_DESCRIPTIONS, ALL_TOOL_NAMES } from '../constants.js';
import { getMcpProviderMetadata } from '@bike4mind/common';

describe('Notion tool description sync', () => {
  const fallback = getMcpProviderMetadata('notion')?.defaultToolDescriptions ?? {};

  it('MCP_PROVIDER_METADATA covers every tool in TOOL_DESCRIPTIONS', () => {
    expect(Object.keys(fallback).sort()).toEqual(Object.keys(TOOL_DESCRIPTIONS).sort());
  });

  for (const toolName of ALL_TOOL_NAMES) {
    it(`${toolName} description matches between constants and provider metadata`, () => {
      expect(fallback[toolName]).toBe(TOOL_DESCRIPTIONS[toolName]);
    });
  }
});
