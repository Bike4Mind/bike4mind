import { describe, expect, it } from 'vitest';
import { AGENT_STATE_LABEL, type AgentState } from '@shared/agentState';
import {
  DEFAULT_SKIN_THEME,
  STATE_PALETTE,
  mergeSkinTheme,
  skinCssVariables,
  stateLampColor,
  stateSkinSx,
} from './statePalette';
import { sampleSkinSummary } from './sampleSkin';

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

describe('mergeSkinTheme', () => {
  it('applies a skin over the palette', () => {
    const theme = mergeSkinTheme(sampleSkinSummary());
    expect(theme.id).toBe('nightglass');
    expect(theme.states).toMatchObject({ working: '#3cc8ff', done: '#b48cff', failed: '#ff5f87' });
    expect(theme.surfaces).toEqual({ stage: '#0f1a24', card: '#16263a' });
    expect(theme.fontFamily).toMatch(/monospace/);
    expect(theme.sprites.aquariumBackdrop).toBe('b4m-skin://nightglass/sprites/tank.png');
    expect(theme.sounds.finale).toBe('b4m-skin://nightglass/sounds/finale.ogg');
  });

  it('locks the "needs you" colour and sound whatever the skin says', () => {
    const skin = sampleSkinSummary();
    // The sample deliberately sets both.
    expect(skin.tokens.states?.['needs-you']).toBe('#ff00ff');
    expect(skin.tokens.sounds?.['needs-you']).toBeDefined();

    const theme = mergeSkinTheme(skin);
    const variables = skinCssVariables(theme);

    expect(theme.states).not.toHaveProperty('needs-you');
    expect(theme.sounds).toEqual({ finale: 'b4m-skin://nightglass/sounds/finale.ogg' });
    expect(Object.keys(variables).some(name => name.includes('needs-you'))).toBe(false);
    expect(Object.values(variables)).not.toContain('#ff00ff');
    expect(stateLampColor('needs-you')).toBe(STATE_PALETTE['needs-you'].lamp);
    expect(stateSkinSx('needs-you', 'solid')).toEqual({});
  });

  it('is the default for no skin or a broken one', () => {
    expect(mergeSkinTheme(undefined)).toBe(DEFAULT_SKIN_THEME);
    expect(mergeSkinTheme({ status: 'broken', id: 'x', error: 'bad' })).toBe(DEFAULT_SKIN_THEME);
    expect(skinCssVariables(DEFAULT_SKIN_THEME)).toEqual({});
  });

  it('reads a skinnable state through its variable, falling back to the palette', () => {
    expect(stateLampColor('working')).toBe('var(--b4m-skin-state-working, #ff9d3c)');
    expect(stateSkinSx('done', 'soft')).toEqual({
      backgroundColor: 'var(--b4m-skin-state-done-soft, var(--joy-palette-success-softBg))',
    });
  });
});
