import { z } from 'zod';

// Zod schemas for the token source. The source is data; this schema is the
// contract every emitter target can rely on. Keep it platform-neutral: no
// MUI/Joy names here (the Joy mapping lives in emitters/joy.ts).

/** #RGB, #RGBA, #RRGGBB or #RRGGBBAA. */
export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected a hex color');

/** rgb()/rgba() in the exact "rgba(r, g, b, a)" shape the token data uses. */
export const rgbaColorSchema = z
  .string()
  .regex(/^rgba?\(\d{1,3}, \d{1,3}, \d{1,3}(?:, (?:0|1|0?\.\d+))?\)$/, 'expected an rgb()/rgba() color');

/**
 * A reference to another token by dotted path (e.g. "neutral.200"), resolved
 * by the consuming platform's palette. Used sparingly; prefer literal colors.
 */
export const tokenReferenceSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z]*\.[a-zA-Z0-9]+$/, 'expected a dotted token reference');

export const colorValueSchema = z.union([hexColorSchema, rgbaColorSchema, tokenReferenceSchema]);

/** Compound CSS values (border shorthands, gradients). Web-oriented escape hatch. */
export const cssValueSchema = z.string().min(1);

/** A color ramp: numeric stop -> color. */
export const colorRampSchema = z.record(z.string().regex(/^\d+$/), hexColorSchema);

/** Alpha variants: base stop -> opacity percent -> translucent color. */
export const alphaRampSchema = z.record(
  z.string(),
  z.record(z.string().regex(/^\d+$/), z.union([rgbaColorSchema, hexColorSchema]))
);

export const colorPrimitivesSchema = z.strictObject({
  ramps: z.record(z.string(), colorRampSchema),
  alphas: z.record(z.string(), alphaRampSchema),
  unique: z.record(z.string(), hexColorSchema),
});

/**
 * Interaction tones for one intent (accent, neutral, success, danger,
 * warning). Every field is optional: each mode overrides only the tones the
 * design actually specifies, and emitters must emit exactly the defined keys
 * so the platform defaults keep covering the rest.
 */
export const interactionTonesSchema = z.strictObject({
  solidBackground: colorValueSchema.optional(),
  solidText: colorValueSchema.optional(),
  solidHoverBackground: colorValueSchema.optional(),
  solidActiveBackground: colorValueSchema.optional(),
  solidDisabledBackground: colorValueSchema.optional(),
  solidDisabledText: colorValueSchema.optional(),
  solidBorder: cssValueSchema.optional(),
  outlinedText: colorValueSchema.optional(),
  outlinedBorder: colorValueSchema.optional(),
  outlinedHoverBackground: colorValueSchema.optional(),
  subtleBackground: colorValueSchema.optional(),
  subtleText: colorValueSchema.optional(),
  subtleHoverBackground: colorValueSchema.optional(),
  subtleHoverText: colorValueSchema.optional(),
  subtleActiveBackground: colorValueSchema.optional(),
  subtleActiveText: colorValueSchema.optional(),
  plainActiveBackground: colorValueSchema.optional(),
  /** The intent's main channel color, for derived uses (charts, badges). */
  main: colorValueSchema.optional(),
});

/** One mode (light or dark) of the semantic color scheme. */
export const semanticColorSchemeSchema = z.strictObject({
  divider: colorValueSchema,
  text: z.strictObject({
    primary: colorValueSchema,
    secondary: colorValueSchema,
    tertiary: colorValueSchema,
    icon: colorValueSchema,
    navLinks: colorValueSchema,
    primary50: colorValueSchema,
    primary70: colorValueSchema,
  }),
  border: z.strictObject({
    light: colorValueSchema,
    solid: colorValueSchema,
    input: colorValueSchema,
    muted: colorValueSchema,
    soft: colorValueSchema,
  }),
  background: z.strictObject({
    body: colorValueSchema,
    surface: colorValueSchema,
    surface2: colorValueSchema,
    panel: colorValueSchema,
    panel2: colorValueSchema,
    sidebarItem: colorValueSchema,
    scrollbar: colorValueSchema,
    scrollbarTrack: colorValueSchema,
  }),
  accent: interactionTonesSchema,
  neutral: interactionTonesSchema,
  success: interactionTonesSchema,
  danger: interactionTonesSchema,
  warning: interactionTonesSchema,
  feedback: z.strictObject({
    background: colorValueSchema,
    border: cssValueSchema,
    bug: colorValueSchema,
    feedback: colorValueSchema,
    positive: colorValueSchema,
    thumbsDown: colorValueSchema,
  }),
  promptEnhancement: z.strictObject({
    background: colorValueSchema,
    backgroundHover: colorValueSchema,
    border: colorValueSchema,
    iconColor: colorValueSchema,
    textColor: colorValueSchema,
    chipBackground: colorValueSchema,
    chipColor: colorValueSchema,
    chipBorder: colorValueSchema,
    enhancedPromptBackground: colorValueSchema,
    enhancedPromptBorder: colorValueSchema,
  }),
});

export const typographySchema = z.strictObject({
  fontFamily: z.strictObject({
    body: z.string().min(1),
    display: z.string().min(1),
  }),
  /** rem-based size ramp. */
  fontSize: z.record(z.string(), z.string().regex(/^[\d.]+rem$/)),
  fontWeight: z.record(z.string(), z.number().int().min(100).max(1000)),
  /** Unitless line heights, as strings to preserve exact precision. */
  lineHeight: z.record(z.string(), z.string().regex(/^[\d.]+$/)),
});

export const spacingSchema = z.strictObject({
  /** Base spacing unit in px; spacing steps are integer multiples of it. */
  unit: z.number().positive(),
});

export const radiiSchema = z.strictObject({
  xs: z.number().nonnegative(),
  sm: z.number().nonnegative(),
  md: z.number().nonnegative(),
  lg: z.number().nonnegative(),
  xl: z.number().nonnegative(),
});

const shadowLayerSchema = z.strictObject({
  offsetX: z.number(),
  offsetY: z.number(),
  blur: z.number().nonnegative(),
  spread: z.number(),
});

export const shadowsSchema = z.strictObject({
  /** Shadow color as an "r g b" channel plus opacity, shared by all levels. */
  channel: z.string().regex(/^\d{1,3} \d{1,3} \d{1,3}$/),
  opacity: z.number().min(0).max(1),
  levels: z.strictObject({
    xs: z.array(shadowLayerSchema).min(1),
    sm: z.array(shadowLayerSchema).min(1),
    md: z.array(shadowLayerSchema).min(1),
    lg: z.array(shadowLayerSchema).min(1),
    xl: z.array(shadowLayerSchema).min(1),
  }),
});

export const motionSchema = z.strictObject({
  /** Durations in milliseconds. */
  duration: z.strictObject({
    fast: z.number().positive(),
    standard: z.number().positive(),
    slow: z.number().positive(),
    slower: z.number().positive(),
  }),
});

export const designTokensSchema = z.strictObject({
  color: z.strictObject({
    primitives: colorPrimitivesSchema,
    schemes: z.strictObject({
      light: semanticColorSchemeSchema,
      dark: semanticColorSchemeSchema,
    }),
  }),
  typography: typographySchema,
  spacing: spacingSchema,
  radii: radiiSchema,
  shadows: shadowsSchema,
  motion: motionSchema,
});

export type HexColor = z.infer<typeof hexColorSchema>;
export type ColorValue = z.infer<typeof colorValueSchema>;
export type InteractionTones = z.infer<typeof interactionTonesSchema>;
export type SemanticColorScheme = z.infer<typeof semanticColorSchemeSchema>;
export type DesignTokens = z.infer<typeof designTokensSchema>;
export type ColorSchemeMode = keyof DesignTokens['color']['schemes'];
