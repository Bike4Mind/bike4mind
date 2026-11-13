import type { DesignTokens, InteractionTones, SemanticColorScheme } from '../schema';
import type { TokenEmitter } from './types';

// The explicit semantic -> MUI Joy mapping layer. Joy is the web theme
// engine, so this emitter speaks Joy's palette vocabulary; the token source
// stays platform-neutral.

export type JoyPaletteFragment = {
  divider: string;
  text: SemanticColorScheme['text'];
  border: SemanticColorScheme['border'];
  background: SemanticColorScheme['background'];
  primary: Record<string, string>;
  neutral: Record<string, string>;
  success: Record<string, string>;
  danger: Record<string, string>;
  warning: Record<string, string>;
  feedback: SemanticColorScheme['feedback'];
  promptEnhancement: SemanticColorScheme['promptEnhancement'];
};

export type JoyThemeFragment = {
  colorSchemes: {
    light: { palette: JoyPaletteFragment };
    dark: { palette: JoyPaletteFragment };
  };
  fontFamily: DesignTokens['typography']['fontFamily'];
  fontSize: DesignTokens['typography']['fontSize'];
  fontWeight: DesignTokens['typography']['fontWeight'];
  lineHeight: DesignTokens['typography']['lineHeight'];
  borderRadius: number;
  /** Joy's spacing unit in px (`theme.spacing(n)` is `n * spacing` px). */
  spacing: number;
  radius: Record<keyof DesignTokens['radii'], string>;
  shadow: Record<keyof DesignTokens['shadows']['levels'], string>;
  /** Joy has no motion slot; this rides through `extendTheme` as a custom key. */
  motion: DesignTokens['motion'];
};

/** Semantic interaction-tone names -> Joy palette variant names. */
const TONE_TO_JOY: Record<keyof InteractionTones, string> = {
  solidBackground: 'solidBg',
  solidText: 'solidColor',
  solidHoverBackground: 'solidHoverBg',
  solidActiveBackground: 'solidActiveBg',
  solidDisabledBackground: 'solidDisabledBg',
  solidDisabledText: 'solidDisabledColor',
  solidBorder: 'solidBorder',
  outlinedText: 'outlinedColor',
  outlinedBorder: 'outlinedBorder',
  outlinedHoverBackground: 'outlinedHoverBg',
  subtleBackground: 'softBg',
  subtleText: 'softColor',
  subtleHoverBackground: 'softHoverBg',
  subtleHoverText: 'softHoverColor',
  subtleActiveBackground: 'softActiveBg',
  subtleActiveText: 'softActiveColor',
  plainActiveBackground: 'plainActiveBg',
  main: 'mainChannel',
};

// Emit exactly the keys the mode defines: an undefined tone must stay absent
// so Joy's own defaults keep covering it (emitting extras would change the
// rendered theme).
const toJoyTones = (tones: InteractionTones): Record<string, string> => {
  const joyTones: Record<string, string> = {};
  for (const [semanticName, joyName] of Object.entries(TONE_TO_JOY) as Array<[keyof InteractionTones, string]>) {
    const value = tones[semanticName];
    if (value !== undefined) {
      joyTones[joyName] = value;
    }
  }
  return joyTones;
};

const toJoyPalette = (scheme: SemanticColorScheme): JoyPaletteFragment => ({
  divider: scheme.divider,
  text: { ...scheme.text },
  border: { ...scheme.border },
  background: { ...scheme.background },
  primary: toJoyTones(scheme.accent),
  neutral: toJoyTones(scheme.neutral),
  success: toJoyTones(scheme.success),
  danger: toJoyTones(scheme.danger),
  warning: toJoyTones(scheme.warning),
  feedback: { ...scheme.feedback },
  promptEnhancement: { ...scheme.promptEnhancement },
});

// Joy wraps every shadow in its ring var and shadow channel/opacity vars; the
// fallbacks are the token defaults, so the output is Joy's own default string.
const toJoyShadow = (shadows: DesignTokens['shadows'], layers: Array<DesignTokens['shadows']['levels']['xs'][number]>) =>
  [
    'var(--joy-shadowRing, 0 0 #000)',
    ...layers.map(
      l =>
        `${l.offsetX}px ${l.offsetY}px ${l.blur}px ${l.spread}px ` +
        `rgba(var(--joy-shadowChannel, ${shadows.channel}) / var(--joy-shadowOpacity, ${shadows.opacity}))`
    ),
  ].join(', ');

const mapEntries = <K extends string, V, R>(record: Record<K, V>, fn: (value: V) => R) =>
  Object.fromEntries(Object.entries<V>(record).map(([key, value]) => [key, fn(value)])) as Record<K, R>;

export const emitJoyThemeFragment = (tokens: DesignTokens): JoyThemeFragment => ({
  colorSchemes: {
    light: { palette: toJoyPalette(tokens.color.schemes.light) },
    dark: { palette: toJoyPalette(tokens.color.schemes.dark) },
  },
  fontFamily: { ...tokens.typography.fontFamily },
  fontSize: { ...tokens.typography.fontSize },
  fontWeight: { ...tokens.typography.fontWeight },
  lineHeight: { ...tokens.typography.lineHeight },
  // The theme's root borderRadius has always been 8px, which is radii.md.
  borderRadius: tokens.radii.md,
  spacing: tokens.spacing.unit,
  radius: mapEntries(tokens.radii, px => `${px}px`),
  shadow: mapEntries(tokens.shadows.levels, layers => toJoyShadow(tokens.shadows, layers)),
  motion: { duration: { ...tokens.motion.duration } },
});

export const joyEmitter: TokenEmitter<JoyThemeFragment> = {
  target: 'joy',
  emit: emitJoyThemeFragment,
};
