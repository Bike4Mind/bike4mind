import type { ColorPaletteProp } from '@mui/joy/styles';
import type { AgentState } from '@shared/agentState';
import type { SceneSkin, SkinSummary, SkinTokens } from '@shared/mods';
import { NEEDS_YOU_AMBER, contrastRatio, looksLikeNeedsYou } from '@shared/needsYouColor';

/**
 * The one place an agent state gets its colour. `joy` drives chips and tiles; `lamp` is the raw hex for
 * scene lamps, tokens and note pins, which cannot take a Joy palette name. Views import this rather than
 * keep their own map (skinViews.test.tsx scans for strays), so a skin overrides the palette in one spot.
 */
export interface StateColor {
  joy: ColorPaletteProp;
  lamp: string;
}

export const STATE_PALETTE: Readonly<Record<AgentState, StateColor>> = {
  'needs-you': { joy: 'warning', lamp: NEEDS_YOU_AMBER },
  working: { joy: 'primary', lamp: '#ff9d3c' },
  waiting: { joy: 'primary', lamp: '#6fa8dc' },
  done: { joy: 'success', lamp: '#7ed07a' },
  failed: { joy: 'danger', lamp: '#e5534b' },
  paused: { joy: 'neutral', lamp: '#c9b27a' },
  stopped: { joy: 'neutral', lamp: '#a89a88' },
  idle: { joy: 'neutral', lamp: '#a89a88' },
};

/** "Needs you" is the one signal a user must never lose, so no skin can recolour it, its pulse or its sound. */
export type SkinnableState = Exclude<AgentState, 'needs-you'>;

const isSkinnable = (state: AgentState): state is SkinnableState => state !== 'needs-you';

/** Set on the document root by useApplySkin (skins.ts) while a skin is active; unset means the palette. */
const stateVariable = (state: SkinnableState): string => `--b4m-skin-state-${state}`;
const softVariable = (state: SkinnableState): string => `--b4m-skin-state-${state}-soft`;
export const SKIN_STAGE_VARIABLE = '--b4m-skin-stage';
export const SKIN_CARD_VARIABLE = '--b4m-skin-card';

export const stateJoyColor = (state: AgentState): ColorPaletteProp => STATE_PALETTE[state].joy;

/** A CSS colour: the skin's when one is active, else the palette's hex. */
export const stateLampColor = (state: AgentState): string =>
  isSkinnable(state) ? `var(${stateVariable(state)}, ${STATE_PALETTE[state].lamp})` : STATE_PALETTE[state].lamp;

export type StateVariant = 'solid' | 'soft' | 'outlined';

/**
 * Styles to spread after a Joy component's `color={stateJoyColor(state)}`, so a skin's colour shows on
 * chips and tile dots too. Each falls back to the Joy token the component would have used anyway.
 */
export function stateSkinSx(state: AgentState, variant: StateVariant): Record<string, string> {
  if (!isSkinnable(state)) return {};
  const joy = STATE_PALETTE[state].joy;
  if (variant === 'solid') {
    return { backgroundColor: `var(${stateVariable(state)}, var(--joy-palette-${joy}-solidBg))` };
  }
  if (variant === 'soft') {
    return { backgroundColor: `var(${softVariable(state)}, var(--joy-palette-${joy}-softBg))` };
  }
  return { borderColor: `var(${stateVariable(state)}, var(--joy-palette-${joy}-outlinedBorder))` };
}

const FONT_STACKS: Record<NonNullable<NonNullable<SkinTokens['type']>['family']>, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, Menlo, Consolas, monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
};

/** What an active skin changes. Everything absent keeps the built-in look. */
export interface SkinTheme {
  id: string | null;
  states: Partial<Record<SkinnableState, string>>;
  surfaces: { stage?: string; card?: string };
  fontFamily?: string;
  /** Keyed by scene id; scene/sceneSkin.ts merges a block over its scene and validates the result. */
  scenes: Readonly<Record<string, SceneSkin>>;
  /** No `needs-you` key, by construction: that sound stays the built-in chime. */
  sounds: { finale?: string };
}

export const DEFAULT_SKIN_THEME: SkinTheme = { id: null, states: {}, surfaces: {}, scenes: {}, sounds: {} };

/**
 * A skin's tokens over the shared palette. This is where the lock lives: whatever a skin says for
 * `needs-you` (colour or sound) is dropped here, and so is any other state or surface colour that
 * looks like the needs-you amber (needsYouColor.ts), so no view or picker can apply it. A broken or
 * missing skin is the default.
 */
export function mergeSkinTheme(skin: SkinSummary | undefined): SkinTheme {
  if (!skin || skin.status !== 'ok') return DEFAULT_SKIN_THEME;
  const { states = {}, surfaces = {}, type = {}, scenes = {}, sounds = {} } = skin.tokens;
  const skinnedStates: SkinTheme['states'] = {};
  for (const [state, color] of Object.entries(states) as [AgentState, string | undefined][]) {
    if (color !== undefined && isSkinnable(state) && !looksLikeNeedsYou(color)) skinnedStates[state] = color;
  }
  const skinnedSurfaces = Object.fromEntries(
    Object.entries(surfaces).filter(([, color]) => color !== undefined && !looksLikeNeedsYou(color))
  ) as SkinTheme['surfaces'];
  return {
    id: skin.id,
    states: skinnedStates,
    surfaces: skinnedSurfaces,
    ...(type.family ? { fontFamily: FONT_STACKS[type.family] } : {}),
    // Kept by reference: sceneSkin.ts caches each merged scene on its block, so a re-list re-merges once.
    scenes,
    sounds: sounds.finale ? { finale: sounds.finale } : {},
  };
}

// Approximates Joy's text.primary per mode; text colour follows the mode, not the skin.
const MODE_TEXT: Record<'light' | 'dark', string> = { light: '#171a1c', dark: '#f0f4f8' };
const MIN_TEXT_CONTRAST = 4.5;

/**
 * The custom properties a theme sets on the document root; empty for the default. A surface the
 * mode's text could not be read on (WCAG AA) is left out, so the built-in surface stays.
 */
export function skinCssVariables(theme: SkinTheme, mode: 'light' | 'dark'): Record<string, string> {
  const readable = (surface: string) => contrastRatio(surface, MODE_TEXT[mode]) >= MIN_TEXT_CONTRAST;
  const variables: Record<string, string> = {};
  for (const [state, color] of Object.entries(theme.states) as [SkinnableState, string][]) {
    variables[stateVariable(state)] = color;
    variables[softVariable(state)] = `color-mix(in srgb, ${color} 22%, transparent)`;
  }
  if (theme.surfaces.stage && readable(theme.surfaces.stage)) variables[SKIN_STAGE_VARIABLE] = theme.surfaces.stage;
  if (theme.surfaces.card && readable(theme.surfaces.card)) variables[SKIN_CARD_VARIABLE] = theme.surfaces.card;
  return variables;
}
