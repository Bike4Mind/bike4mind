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
  it('drops any state or surface colour that looks like the needs-you amber, keeping the rest', () => {
    const skin = sampleSkinSummary();
    if (skin.status !== 'ok') throw new Error('sample skin is broken');
    const theme = mergeSkinTheme({
      ...skin,
      tokens: {
        ...skin.tokens,
        states: { working: STATE_PALETTE['needs-you'].lamp, done: '#f0c050', failed: '#3cc8ff' },
        surfaces: { stage: '#ffcc00', card: '#16263a' },
      },
    });

    expect(theme.states).toEqual({ failed: '#3cc8ff' });
    expect(theme.surfaces).toEqual({ card: '#16263a' });
    expect(Object.values(skinCssVariables(theme, 'dark'))).not.toContain(STATE_PALETTE['needs-you'].lamp);
  });

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
    const variables = skinCssVariables(theme, 'dark');

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
    expect(skinCssVariables(DEFAULT_SKIN_THEME, 'light')).toEqual({});
  });

  it('drops surfaces its mode text could not be read on', () => {
    const dark = mergeSkinTheme(sampleSkinSummary());
    const light = { ...dark, surfaces: { stage: '#f4efe6', card: '#fbf8f2' } };

    expect(skinCssVariables(dark, 'light')).not.toHaveProperty('--b4m-skin-stage');
    expect(skinCssVariables(dark, 'light')).not.toHaveProperty('--b4m-skin-card');
    expect(skinCssVariables(dark, 'dark')).toMatchObject({
      '--b4m-skin-stage': '#0f1a24',
      '--b4m-skin-card': '#16263a',
    });
    expect(skinCssVariables(light, 'light')).toMatchObject({
      '--b4m-skin-stage': '#f4efe6',
      '--b4m-skin-card': '#fbf8f2',
    });
    expect(skinCssVariables(light, 'dark')).not.toHaveProperty('--b4m-skin-stage');
  });

  it('still applies state colours whatever the mode', () => {
    const theme = mergeSkinTheme(sampleSkinSummary());
    expect(skinCssVariables(theme, 'light')).toHaveProperty('--b4m-skin-state-working', '#3cc8ff');
  });

  it('reads a skinnable state through its variable, falling back to the palette', () => {
    expect(stateLampColor('working')).toBe('var(--b4m-skin-state-working, #ff9d3c)');
    expect(stateSkinSx('done', 'soft')).toEqual({
      backgroundColor: 'var(--b4m-skin-state-done-soft, var(--joy-palette-success-softBg))',
    });
  });
});
