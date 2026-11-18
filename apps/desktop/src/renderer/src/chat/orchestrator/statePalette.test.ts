import { describe, expect, it } from 'vitest';
import { AGENT_STATE_LABEL, type AgentState } from '@shared/agentState';
import { STATE_PALETTE } from './statePalette';

const sources = import.meta.glob<string>(['./**/*.ts', './**/*.tsx', '!./**/*.test.*', '!./statePalette.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('STATE_PALETTE', () => {
  it('colours every agent state', () => {
    for (const state of Object.keys(AGENT_STATE_LABEL) as AgentState[]) {
      expect(STATE_PALETTE[state].joy).toBeTruthy();
      expect(STATE_PALETTE[state].lamp).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('is the only place under chat/orchestrator that maps an agent state to a colour', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    // A Record keyed by AgentState whose values are Joy colours or plain strings (hex) is a colour map.
    const colourMap = /Record<\s*AgentState\s*,\s*(ColorPaletteProp|string)\s*>/;
    const offenders = Object.entries(sources)
      .filter(([, source]) => colourMap.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
