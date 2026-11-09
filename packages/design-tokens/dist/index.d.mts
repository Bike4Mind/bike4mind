import { z } from "zod";
//#region src/schema.d.ts
/** #RGB, #RGBA, #RRGGBB or #RRGGBBAA. */
declare const hexColorSchema: z.ZodString;
/** rgb()/rgba() in the exact "rgba(r, g, b, a)" shape the token data uses. */
declare const rgbaColorSchema: z.ZodString;
/**
 * A reference to another token by dotted path (e.g. "neutral.200"), resolved
 * by the consuming platform's palette. Used sparingly; prefer literal colors.
 */
declare const tokenReferenceSchema: z.ZodString;
declare const colorValueSchema: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
/** Compound CSS values (border shorthands, gradients). Web-oriented escape hatch. */
declare const cssValueSchema: z.ZodString;
/** A color ramp: numeric stop -> color. */
declare const colorRampSchema: z.ZodRecord<z.ZodString, z.ZodString>;
/** Alpha variants: base stop -> opacity percent -> translucent color. */
declare const alphaRampSchema: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodString]>>>;
declare const colorPrimitivesSchema: z.ZodObject<{
  ramps: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>>;
  alphas: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodString]>>>>;
  unique: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strict>;
/**
 * Interaction tones for one intent (accent, neutral, success, danger,
 * warning). Every field is optional: each mode overrides only the tones the
 * design actually specifies, and emitters must emit exactly the defined keys
 * so the platform defaults keep covering the rest.
 */
declare const interactionTonesSchema: z.ZodObject<{
  solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  solidBorder: z.ZodOptional<z.ZodString>;
  outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
}, z.core.$strict>;
/** One mode (light or dark) of the semantic color scheme. */
declare const semanticColorSchemeSchema: z.ZodObject<{
  divider: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
  text: z.ZodObject<{
    primary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    secondary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    tertiary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    icon: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    navLinks: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    primary50: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    primary70: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
  }, z.core.$strict>;
  border: z.ZodObject<{
    light: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    solid: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    input: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    muted: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    soft: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
  }, z.core.$strict>;
  background: z.ZodObject<{
    body: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    surface: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    surface2: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    panel: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    panel2: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    sidebarItem: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    scrollbar: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    scrollbarTrack: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
  }, z.core.$strict>;
  accent: z.ZodObject<{
    solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidBorder: z.ZodOptional<z.ZodString>;
    outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  }, z.core.$strict>;
  neutral: z.ZodObject<{
    solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidBorder: z.ZodOptional<z.ZodString>;
    outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  }, z.core.$strict>;
  success: z.ZodObject<{
    solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidBorder: z.ZodOptional<z.ZodString>;
    outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  }, z.core.$strict>;
  danger: z.ZodObject<{
    solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidBorder: z.ZodOptional<z.ZodString>;
    outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  }, z.core.$strict>;
  warning: z.ZodObject<{
    solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    solidBorder: z.ZodOptional<z.ZodString>;
    outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
    main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
  }, z.core.$strict>;
  feedback: z.ZodObject<{
    background: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    border: z.ZodString;
    bug: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    feedback: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    positive: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    thumbsDown: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
  }, z.core.$strict>;
  promptEnhancement: z.ZodObject<{
    background: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    backgroundHover: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    border: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    iconColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    textColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    chipBackground: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    chipColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    chipBorder: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    enhancedPromptBackground: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
    enhancedPromptBorder: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
  }, z.core.$strict>;
}, z.core.$strict>;
declare const typographySchema: z.ZodObject<{
  fontFamily: z.ZodObject<{
    body: z.ZodString;
    display: z.ZodString;
  }, z.core.$strict>;
  fontSize: z.ZodRecord<z.ZodString, z.ZodString>;
  fontWeight: z.ZodRecord<z.ZodString, z.ZodNumber>;
  lineHeight: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strict>;
declare const spacingSchema: z.ZodObject<{
  unit: z.ZodNumber;
}, z.core.$strict>;
declare const radiiSchema: z.ZodObject<{
  xs: z.ZodNumber;
  sm: z.ZodNumber;
  md: z.ZodNumber;
  lg: z.ZodNumber;
  xl: z.ZodNumber;
}, z.core.$strict>;
declare const shadowsSchema: z.ZodObject<{
  channel: z.ZodString;
  opacity: z.ZodNumber;
  levels: z.ZodObject<{
    xs: z.ZodArray<z.ZodObject<{
      offsetX: z.ZodNumber;
      offsetY: z.ZodNumber;
      blur: z.ZodNumber;
      spread: z.ZodNumber;
    }, z.core.$strict>>;
    sm: z.ZodArray<z.ZodObject<{
      offsetX: z.ZodNumber;
      offsetY: z.ZodNumber;
      blur: z.ZodNumber;
      spread: z.ZodNumber;
    }, z.core.$strict>>;
    md: z.ZodArray<z.ZodObject<{
      offsetX: z.ZodNumber;
      offsetY: z.ZodNumber;
      blur: z.ZodNumber;
      spread: z.ZodNumber;
    }, z.core.$strict>>;
    lg: z.ZodArray<z.ZodObject<{
      offsetX: z.ZodNumber;
      offsetY: z.ZodNumber;
      blur: z.ZodNumber;
      spread: z.ZodNumber;
    }, z.core.$strict>>;
    xl: z.ZodArray<z.ZodObject<{
      offsetX: z.ZodNumber;
      offsetY: z.ZodNumber;
      blur: z.ZodNumber;
      spread: z.ZodNumber;
    }, z.core.$strict>>;
  }, z.core.$strict>;
}, z.core.$strict>;
declare const motionSchema: z.ZodObject<{
  duration: z.ZodObject<{
    fast: z.ZodNumber;
    standard: z.ZodNumber;
    slow: z.ZodNumber;
    slower: z.ZodNumber;
  }, z.core.$strict>;
}, z.core.$strict>;
declare const designTokensSchema: z.ZodObject<{
  color: z.ZodObject<{
    primitives: z.ZodObject<{
      ramps: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>>;
      alphas: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodString]>>>>;
      unique: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strict>;
    schemes: z.ZodObject<{
      light: z.ZodObject<{
        divider: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        text: z.ZodObject<{
          primary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          secondary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          tertiary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          icon: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          navLinks: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          primary50: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          primary70: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
        border: z.ZodObject<{
          light: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          solid: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          input: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          muted: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          soft: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
        background: z.ZodObject<{
          body: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          surface: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          surface2: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          panel: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          panel2: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          sidebarItem: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          scrollbar: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          scrollbarTrack: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
        accent: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        neutral: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        success: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        danger: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        warning: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        feedback: z.ZodObject<{
          background: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          border: z.ZodString;
          bug: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          feedback: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          positive: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          thumbsDown: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
        promptEnhancement: z.ZodObject<{
          background: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          backgroundHover: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          border: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          iconColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          textColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          chipBackground: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          chipColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          chipBorder: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          enhancedPromptBackground: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          enhancedPromptBorder: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
      }, z.core.$strict>;
      dark: z.ZodObject<{
        divider: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        text: z.ZodObject<{
          primary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          secondary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          tertiary: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          icon: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          navLinks: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          primary50: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          primary70: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
        border: z.ZodObject<{
          light: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          solid: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          input: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          muted: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          soft: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
        background: z.ZodObject<{
          body: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          surface: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          surface2: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          panel: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          panel2: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          sidebarItem: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          scrollbar: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          scrollbarTrack: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
        accent: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        neutral: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        success: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        danger: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        warning: z.ZodObject<{
          solidBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidDisabledText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          solidBorder: z.ZodOptional<z.ZodString>;
          outlinedText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedBorder: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          outlinedHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleHoverText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          subtleActiveText: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          plainActiveBackground: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
          main: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>>;
        }, z.core.$strict>;
        feedback: z.ZodObject<{
          background: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          border: z.ZodString;
          bug: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          feedback: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          positive: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          thumbsDown: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
        promptEnhancement: z.ZodObject<{
          background: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          backgroundHover: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          border: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          iconColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          textColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          chipBackground: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          chipColor: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          chipBorder: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          enhancedPromptBackground: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
          enhancedPromptBorder: z.ZodUnion<readonly [z.ZodString, z.ZodString, z.ZodString]>;
        }, z.core.$strict>;
      }, z.core.$strict>;
    }, z.core.$strict>;
  }, z.core.$strict>;
  typography: z.ZodObject<{
    fontFamily: z.ZodObject<{
      body: z.ZodString;
      display: z.ZodString;
    }, z.core.$strict>;
    fontSize: z.ZodRecord<z.ZodString, z.ZodString>;
    fontWeight: z.ZodRecord<z.ZodString, z.ZodNumber>;
    lineHeight: z.ZodRecord<z.ZodString, z.ZodString>;
  }, z.core.$strict>;
  spacing: z.ZodObject<{
    unit: z.ZodNumber;
  }, z.core.$strict>;
  radii: z.ZodObject<{
    xs: z.ZodNumber;
    sm: z.ZodNumber;
    md: z.ZodNumber;
    lg: z.ZodNumber;
    xl: z.ZodNumber;
  }, z.core.$strict>;
  shadows: z.ZodObject<{
    channel: z.ZodString;
    opacity: z.ZodNumber;
    levels: z.ZodObject<{
      xs: z.ZodArray<z.ZodObject<{
        offsetX: z.ZodNumber;
        offsetY: z.ZodNumber;
        blur: z.ZodNumber;
        spread: z.ZodNumber;
      }, z.core.$strict>>;
      sm: z.ZodArray<z.ZodObject<{
        offsetX: z.ZodNumber;
        offsetY: z.ZodNumber;
        blur: z.ZodNumber;
        spread: z.ZodNumber;
      }, z.core.$strict>>;
      md: z.ZodArray<z.ZodObject<{
        offsetX: z.ZodNumber;
        offsetY: z.ZodNumber;
        blur: z.ZodNumber;
        spread: z.ZodNumber;
      }, z.core.$strict>>;
      lg: z.ZodArray<z.ZodObject<{
        offsetX: z.ZodNumber;
        offsetY: z.ZodNumber;
        blur: z.ZodNumber;
        spread: z.ZodNumber;
      }, z.core.$strict>>;
      xl: z.ZodArray<z.ZodObject<{
        offsetX: z.ZodNumber;
        offsetY: z.ZodNumber;
        blur: z.ZodNumber;
        spread: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>;
  }, z.core.$strict>;
  motion: z.ZodObject<{
    duration: z.ZodObject<{
      fast: z.ZodNumber;
      standard: z.ZodNumber;
      slow: z.ZodNumber;
      slower: z.ZodNumber;
    }, z.core.$strict>;
  }, z.core.$strict>;
}, z.core.$strict>;
type HexColor = z.infer<typeof hexColorSchema>;
type ColorValue = z.infer<typeof colorValueSchema>;
type InteractionTones = z.infer<typeof interactionTonesSchema>;
type SemanticColorScheme = z.infer<typeof semanticColorSchemeSchema>;
type DesignTokens = z.infer<typeof designTokensSchema>;
type ColorSchemeMode = keyof DesignTokens['color']['schemes'];
//#endregion
//#region src/tokens/primitives.d.ts
/** Brand color ramp: the primary blue tones used throughout the product. */
declare const brand: {
  100: string;
  400: string;
  500: string;
  600: string;
  650: string;
  700: string;
  800: string;
  900: string;
};
/** Neutral ramp for backgrounds, borders and text. */
declare const gray: {
  0: string;
  5: string;
  8: string;
  10: string;
  12: string;
  15: string;
  25: string;
  50: string;
  55: string;
  75: string;
  100: string;
  150: string;
  155: string;
  160: string;
  175: string;
  185: string;
  188: string;
  190: string;
  200: string;
  210: string;
  220: string;
  600: string;
  650: string;
  653: string;
  655: string;
  660: string;
  665: string;
  668: string;
  670: string;
  680: string;
  685: string;
  690: string;
  700: string;
  710: string;
  720: string;
  725: string;
  730: string;
  740: string;
  750: string;
  775: string;
  780: string;
  800: string;
  825: string;
  830: string;
  845: string;
  850: string;
  860: string;
  865: string;
  870: string;
  875: string;
  900: string;
  925: string;
};
/** Success states and positive feedback. */
declare const green: {
  375: string;
  400: string;
  450: string;
  500: string;
  550: string;
  600: string;
  650: string;
  800: string;
  850: string;
  875: string;
  900: string;
  925: string;
  950: string;
  975: string;
};
/** Error states and critical alerts. */
declare const red: {
  250: string;
  300: string;
  325: string;
  330: string;
  375: string;
  400: string;
  450: string;
  500: string;
  550: string;
  600: string;
  700: string;
};
/** Warning states and attention-grabbing elements. */
declare const orange: {
  300: string;
  350: string;
  375: string;
  400: string;
  425: string;
  430: string;
  450: string;
  500: string;
  550: string;
  600: string;
  625: string;
  650: string;
};
/** Informational and interactive accents. */
declare const blue: {
  400: string;
  500: string;
  550: string;
  600: string;
  650: string;
  700: string;
  750: string;
  775: string;
  800: string;
};
/** Project and productivity accents. */
declare const teal: {
  600: string;
};
/** Agent and AI-related accents. */
declare const purple: {
  300: string;
  325: string;
  350: string;
  400: string;
  500: string;
  550: string;
  600: string;
  700: string;
  750: string;
};
/** Bright informational accents. */
declare const cyan: {
  50: string;
  100: string;
  300: string;
  400: string;
  500: string;
  600: string;
};
/** Highlight accents (gradients). */
declare const pink: {
  400: string;
  500: string;
};
/** Premium highlight accents. */
declare const gold: {
  400: string;
};
/** Translucent variants of the brand ramp (and fixed one-off bases), as rgba() strings. */
declare const brandAlpha: {
  readonly 100: {
    readonly 4: "rgba(209, 228, 244, 0.04)";
    readonly 5: "rgba(209, 228, 244, 0.05)";
    readonly 8: "rgba(209, 228, 244, 0.08)";
    readonly 12: "rgba(209, 228, 244, 0.12)";
    readonly 15: "rgba(209, 228, 244, 0.15)";
    readonly 20: "rgba(209, 228, 244, 0.2)";
    readonly 25: "rgba(209, 228, 244, 0.25)";
    readonly 30: "rgba(209, 228, 244, 0.3)";
    readonly 35: "rgba(209, 228, 244, 0.35)";
    readonly 50: "rgba(209, 228, 244, 0.5)";
    readonly 70: "rgba(209, 228, 244, 0.7)";
    readonly 75: "rgba(209, 228, 244, 0.75)";
    readonly 80: "rgba(209, 228, 244, 0.8)";
    readonly 85: "rgba(209, 228, 244, 0.85)";
  };
  readonly 400: {
    readonly 5: "rgba(51, 95, 112, 0.05)";
    readonly 7: "rgba(51, 95, 112, 0.07)";
    readonly 8: "rgba(51, 95, 112, 0.08)";
    readonly 25: "rgba(51, 95, 112, 0.25)";
    readonly 30: "rgba(51, 95, 112, 0.3)";
    readonly 35: "rgba(51, 95, 112, 0.35)";
    readonly 40: "rgba(51, 95, 112, 0.4)";
    readonly 50: "rgba(51, 95, 112, 0.5)";
    readonly 60: "rgba(51, 95, 112, 0.6)";
    readonly 70: "rgba(51, 95, 112, 0.7)";
    readonly 90: "rgba(51, 95, 112, 0.9)";
    readonly 95: "rgba(51, 95, 112, 0.95)";
  };
  readonly 500: {
    readonly 5: "rgba(59, 130, 246, 0.05)";
    readonly 8: "rgba(59, 130, 246, 0.08)";
    readonly 10: "rgba(59, 130, 246, 0.1)";
    readonly 15: "rgba(59, 130, 246, 0.15)";
    readonly 25: "rgba(59, 130, 246, 0.25)";
    readonly 30: "rgba(59, 130, 246, 0.3)";
    readonly 40: "rgba(59, 130, 246, 0.4)";
    readonly 60: "rgba(59, 130, 246, 0.6)";
  };
  readonly 600: {
    readonly 4: "rgba(10, 61, 80, 0.04)";
    readonly 20: "rgba(10, 61, 80, 0.2)";
  };
  readonly 650: {
    readonly 70: "rgba(10, 34, 48, 0.7)";
    readonly 85: "rgba(10, 34, 48, 0.85)";
  };
  readonly 700: {
    readonly 3: "rgba(42, 65, 89, 0.03)";
  };
  readonly 800: {
    readonly 1: "rgba(11, 107, 203, 0.01)";
    readonly 2: "rgba(11, 107, 203, 0.02)";
    readonly 5: "rgba(11, 107, 203, 0.05)";
    readonly 8: "rgba(11, 107, 203, 0.08)";
    readonly 10: "rgba(11, 107, 203, 0.1)";
    readonly 12: "rgba(11, 107, 203, 0.12)";
    readonly 15: "rgba(11, 107, 203, 0.15)";
    readonly 20: "rgba(11, 107, 203, 0.2)";
    readonly 25: "rgba(11, 107, 203, 0.25)";
    readonly 50: "rgba(11, 107, 203, 0.5)";
  };
};
/** Translucent variants of the gray ramp (and fixed one-off bases), as rgba() strings. */
declare const grayAlpha: {
  readonly 0: {
    readonly 20: "rgba(255, 255, 255, 0.2)";
    readonly 50: "rgba(255, 255, 255, 0.5)";
  };
  readonly 5: {
    readonly 98: "rgba(241, 245, 249, 0.98)";
  };
  readonly 15: {
    readonly 90: "rgba(248, 250, 252, 0.9)";
    readonly 95: "rgba(248, 250, 252, 0.95)";
    readonly 96: "rgba(248, 250, 252, 0.96)";
  };
  readonly 150: {
    readonly 10: "rgba(190, 209, 223, 0.1)";
    readonly 20: "rgba(190, 209, 223, 0.2)";
    readonly 30: "rgba(190, 209, 223, 0.3)";
    readonly 50: "rgba(190, 209, 223, 0.5)";
    readonly 80: "rgba(190, 209, 223, 0.8)";
  };
  readonly 160: {
    readonly 50: "rgba(201, 203, 205, 0.5)";
  };
  readonly 175: {
    readonly 12: "rgba(224, 224, 224, 0.12)";
  };
  readonly 200: {
    readonly 20: "rgba(211, 223, 232, 0.2)";
    readonly 50: "rgba(211, 223, 232, 0.5)";
    readonly 60: "rgba(211, 223, 232, 0.6)";
  };
  readonly 210: {
    readonly 50: "rgba(211, 228, 244, 0.5)";
  };
  readonly 600: {
    readonly 3: "rgba(115, 123, 130, 0.03)";
  };
  readonly 668: {
    readonly 16: "rgba(128, 128, 128, 0.16)";
  };
  readonly 670: {
    readonly 16: "rgba(136, 136, 136, 0.16)";
  };
  readonly 690: {
    readonly 15: "rgba(107, 114, 128, 0.15)";
    readonly 40: "rgba(107, 114, 128, 0.4)";
  };
  readonly 700: {
    readonly 50: "rgba(48, 54, 58, 0.5)";
  };
  readonly 710: {
    readonly 50: "rgba(50, 56, 62, 0.5)";
  };
  readonly 725: {
    readonly 30: "rgba(55, 65, 81, 0.3)";
    readonly 50: "rgba(55, 65, 81, 0.5)";
  };
  readonly 775: {
    readonly 25: "rgba(42, 44, 56, 0.25)";
    readonly 30: "rgba(42, 44, 56, 0.3)";
    readonly 50: "rgba(42, 44, 56, 0.5)";
    readonly 60: "rgba(42, 44, 56, 0.6)";
    readonly 70: "rgba(42, 44, 56, 0.7)";
  };
  readonly 780: {
    readonly 72: "rgba(30, 41, 59, 0.72)";
  };
  readonly 800: {
    readonly 8: "rgba(44, 49, 53, 0.08)";
    readonly 50: "rgba(44, 49, 53, 0.5)";
  };
  readonly 875: {
    readonly 50: "rgba(16, 17, 17, 0.5)";
  };
};
/** Translucent variants of the green ramp (and fixed one-off bases), as rgba() strings. */
declare const greenAlpha: {
  readonly 375: {
    readonly 15: "rgba(52, 211, 153, 0.15)";
    readonly 22: "rgba(52, 211, 153, 0.22)";
    readonly 28: "rgba(52, 211, 153, 0.28)";
  };
  readonly 400: {
    readonly 40: "rgba(16, 185, 129, 0.4)";
  };
  readonly 500: {
    readonly 2: "rgba(34, 197, 94, 0.02)";
    readonly 15: "rgba(34, 197, 94, 0.15)";
  };
  readonly 600: {
    readonly 12: "rgba(76, 175, 80, 0.12)";
  };
  readonly 800: {
    readonly 2: "rgba(31, 184, 75, 0.02)";
    readonly 4: "rgba(31, 184, 75, 0.04)";
    readonly 5: "rgba(31, 184, 75, 0.05)";
    readonly 6: "rgba(31, 184, 75, 0.06)";
    readonly 8: "rgba(31, 184, 75, 0.08)";
    readonly 10: "rgba(31, 184, 75, 0.1)";
    readonly 15: "rgba(31, 184, 75, 0.15)";
    readonly 20: "rgba(31, 184, 75, 0.2)";
    readonly 30: "rgba(31, 184, 75, 0.3)";
    readonly 50: "rgba(31, 184, 75, 0.5)";
  };
  readonly 900: {
    readonly 5: "rgba(30, 122, 32, 0.05)";
  };
  readonly 950: {
    readonly 20: "rgba(22, 114, 48, 0.2)";
    readonly 40: "rgba(22, 114, 48, 0.4)";
  };
};
/** Translucent variants of the teal ramp (and fixed one-off bases), as rgba() strings. */
declare const tealAlpha: {
  readonly custom: {
    readonly 5: "rgba(92, 184, 166, 0.05)";
  };
};
/** Translucent variants of the white ramp (and fixed one-off bases), as rgba() strings. */
declare const whiteAlpha: {
  readonly 0: {
    readonly 5: "rgba(255, 255, 255, 0.05)";
    readonly 10: "rgba(255, 255, 255, 0.1)";
    readonly 12: "rgba(255, 255, 255, 0.12)";
    readonly 20: "rgba(255, 255, 255, 0.2)";
    readonly 30: "rgba(255, 255, 255, 0.3)";
    readonly 50: "rgba(255, 255, 255, 0.5)";
    readonly 70: "rgba(255, 255, 255, 0.7)";
    readonly 80: "rgba(255, 255, 255, 0.8)";
    readonly 90: "rgba(255, 255, 255, 0.9)";
    readonly 95: "rgba(255, 255, 255, 0.95)";
    readonly 96: "rgba(255, 255, 255, 0.96)";
    readonly 98: "rgba(255, 255, 255, 0.98)";
  };
};
/** Translucent variants of the black ramp (and fixed one-off bases), as rgba() strings. */
declare const blackAlpha: {
  readonly 0: {
    readonly 1: "rgba(0, 0, 0, 0.01)";
    readonly 2: "rgba(0, 0, 0, 0.02)";
    readonly 3: "rgba(0, 0, 0, 0.03)";
    readonly 4: "rgba(0, 0, 0, 0.04)";
    readonly 5: "rgba(0, 0, 0, 0.05)";
    readonly 6: "rgba(0, 0, 0, 0.06)";
    readonly 8: "rgba(0, 0, 0, 0.08)";
    readonly 10: "rgba(0, 0, 0, 0.1)";
    readonly 12: "rgba(0, 0, 0, 0.12)";
    readonly 15: "rgba(0, 0, 0, 0.15)";
    readonly 18: "rgba(0, 0, 0, 0.18)";
    readonly 20: "rgba(0, 0, 0, 0.2)";
    readonly 25: "rgba(0, 0, 0, 0.25)";
    readonly 30: "rgba(0, 0, 0, 0.3)";
    readonly 50: "rgba(0, 0, 0, 0.5)";
  };
};
/** Translucent variants of the red ramp (and fixed one-off bases), as rgba() strings. */
declare const redAlpha: {
  readonly 325: {
    readonly 8: "rgba(234, 61, 61, 0.08)";
    readonly 50: "rgba(234, 61, 61, 0.5)";
  };
  readonly 400: {
    readonly 15: "rgba(239, 68, 68, 0.15)";
    readonly 22: "rgba(239, 68, 68, 0.22)";
    readonly 28: "rgba(239, 68, 68, 0.28)";
    readonly 40: "rgba(239, 68, 68, 0.4)";
  };
  readonly 450: {
    readonly 10: "rgba(255, 107, 107, 0.1)";
  };
  readonly 600: {
    readonly 10: "rgba(218, 49, 49, 0.1)";
    readonly 20: "rgba(218, 49, 49, 0.2)";
  };
};
/** Translucent variants of the purple ramp (and fixed one-off bases), as rgba() strings. */
declare const purpleAlpha: {
  readonly 325: {
    readonly 20: "rgba(165, 180, 252, 0.2)";
  };
  readonly 500: {
    readonly 2: "rgba(139, 92, 246, 0.02)";
    readonly 5: "rgba(139, 92, 246, 0.05)";
    readonly 8: "rgba(139, 92, 246, 0.08)";
    readonly 15: "rgba(139, 92, 246, 0.15)";
    readonly 40: "rgba(139, 92, 246, 0.4)";
  };
  readonly 550: {
    readonly 5: "rgba(147, 51, 234, 0.05)";
    readonly 8: "rgba(147, 51, 234, 0.08)";
  };
};
/** Translucent variants of the orange ramp (and fixed one-off bases), as rgba() strings. */
declare const orangeAlpha: {
  readonly 350: {
    readonly 10: "rgba(255, 172, 88, 0.1)";
  };
  readonly 375: {
    readonly 2: "rgba(251, 146, 60, 0.02)";
    readonly 15: "rgba(251, 146, 60, 0.15)";
    readonly 22: "rgba(251, 146, 60, 0.22)";
    readonly 28: "rgba(251, 146, 60, 0.28)";
  };
  readonly 450: {
    readonly 15: "rgba(255, 165, 0, 0.15)";
    readonly 22: "rgba(255, 165, 0, 0.22)";
    readonly 28: "rgba(255, 165, 0, 0.28)";
  };
  readonly 550: {
    readonly 15: "rgba(245, 158, 11, 0.15)";
    readonly 40: "rgba(245, 158, 11, 0.4)";
  };
};
/** Translucent variants of the cyan ramp (and fixed one-off bases), as rgba() strings. */
declare const cyanAlpha: {
  readonly 400: {
    readonly 40: "rgba(6, 182, 212, 0.4)";
  };
  readonly 600: {
    readonly 70: "rgba(0, 255, 255, 0.7)";
  };
};
/** Translucent variants of the pink ramp (and fixed one-off bases), as rgba() strings. */
declare const pinkAlpha: {
  readonly 400: {
    readonly 40: "rgba(236, 72, 153, 0.4)";
  };
};
/** Translucent variants of the blue ramp (and fixed one-off bases), as rgba() strings. */
declare const blueAlpha: {
  readonly 650: {
    readonly 2: "rgba(13, 110, 253, 0.02)";
    readonly 15: "rgba(13, 110, 253, 0.15)";
    readonly 25: "rgba(13, 110, 253, 0.25)";
    readonly 50: "rgba(13, 110, 253, 0.5)";
    readonly 75: "rgba(13, 110, 253, 0.75)";
  };
};
/** Translucent variants of the gold ramp (and fixed one-off bases), as rgba() strings. */
declare const goldAlpha: {
  readonly 400: {
    readonly 10: "rgba(255, 215, 0, 0.1)";
    readonly 20: "rgba(255, 215, 0, 0.2)";
    readonly 30: "rgba(255, 215, 0, 0.3)";
    readonly 40: "rgba(255, 215, 0, 0.4)";
    readonly 50: "rgba(255, 215, 0, 0.5)";
    readonly 60: "rgba(255, 215, 0, 0.6)";
    readonly 70: "rgba(255, 215, 0, 0.7)";
    readonly 80: "rgba(255, 215, 0, 0.8)";
    readonly 90: "rgba(255, 215, 0, 0.9)";
    readonly 100: "#ffd700";
  };
};
/** Single-purpose colors that belong to no ramp. */
declare const unique: {
  softHoverColor: string;
  solidDisabledColor: string;
  scrollbar: string;
  lightBlue: string;
  limeGreen: string;
  mediumGray: string;
  tealPreview: string;
  almostBlack: string;
  lightBlueOverlay: string;
  lightGrayBackground: string;
};
/** Every color primitive, grouped for schema validation and emitters. */
declare const colorPrimitives: {
  ramps: {
    brand: {
      100: string;
      400: string;
      500: string;
      600: string;
      650: string;
      700: string;
      800: string;
      900: string;
    };
    gray: {
      0: string;
      5: string;
      8: string;
      10: string;
      12: string;
      15: string;
      25: string;
      50: string;
      55: string;
      75: string;
      100: string;
      150: string;
      155: string;
      160: string;
      175: string;
      185: string;
      188: string;
      190: string;
      200: string;
      210: string;
      220: string;
      600: string;
      650: string;
      653: string;
      655: string;
      660: string;
      665: string;
      668: string;
      670: string;
      680: string;
      685: string;
      690: string;
      700: string;
      710: string;
      720: string;
      725: string;
      730: string;
      740: string;
      750: string;
      775: string;
      780: string;
      800: string;
      825: string;
      830: string;
      845: string;
      850: string;
      860: string;
      865: string;
      870: string;
      875: string;
      900: string;
      925: string;
    };
    green: {
      375: string;
      400: string;
      450: string;
      500: string;
      550: string;
      600: string;
      650: string;
      800: string;
      850: string;
      875: string;
      900: string;
      925: string;
      950: string;
      975: string;
    };
    red: {
      250: string;
      300: string;
      325: string;
      330: string;
      375: string;
      400: string;
      450: string;
      500: string;
      550: string;
      600: string;
      700: string;
    };
    orange: {
      300: string;
      350: string;
      375: string;
      400: string;
      425: string;
      430: string;
      450: string;
      500: string;
      550: string;
      600: string;
      625: string;
      650: string;
    };
    blue: {
      400: string;
      500: string;
      550: string;
      600: string;
      650: string;
      700: string;
      750: string;
      775: string;
      800: string;
    };
    teal: {
      600: string;
    };
    purple: {
      300: string;
      325: string;
      350: string;
      400: string;
      500: string;
      550: string;
      600: string;
      700: string;
      750: string;
    };
    cyan: {
      50: string;
      100: string;
      300: string;
      400: string;
      500: string;
      600: string;
    };
    pink: {
      400: string;
      500: string;
    };
    gold: {
      400: string;
    };
  };
  alphas: {
    brand: {
      readonly 100: {
        readonly 4: "rgba(209, 228, 244, 0.04)";
        readonly 5: "rgba(209, 228, 244, 0.05)";
        readonly 8: "rgba(209, 228, 244, 0.08)";
        readonly 12: "rgba(209, 228, 244, 0.12)";
        readonly 15: "rgba(209, 228, 244, 0.15)";
        readonly 20: "rgba(209, 228, 244, 0.2)";
        readonly 25: "rgba(209, 228, 244, 0.25)";
        readonly 30: "rgba(209, 228, 244, 0.3)";
        readonly 35: "rgba(209, 228, 244, 0.35)";
        readonly 50: "rgba(209, 228, 244, 0.5)";
        readonly 70: "rgba(209, 228, 244, 0.7)";
        readonly 75: "rgba(209, 228, 244, 0.75)";
        readonly 80: "rgba(209, 228, 244, 0.8)";
        readonly 85: "rgba(209, 228, 244, 0.85)";
      };
      readonly 400: {
        readonly 5: "rgba(51, 95, 112, 0.05)";
        readonly 7: "rgba(51, 95, 112, 0.07)";
        readonly 8: "rgba(51, 95, 112, 0.08)";
        readonly 25: "rgba(51, 95, 112, 0.25)";
        readonly 30: "rgba(51, 95, 112, 0.3)";
        readonly 35: "rgba(51, 95, 112, 0.35)";
        readonly 40: "rgba(51, 95, 112, 0.4)";
        readonly 50: "rgba(51, 95, 112, 0.5)";
        readonly 60: "rgba(51, 95, 112, 0.6)";
        readonly 70: "rgba(51, 95, 112, 0.7)";
        readonly 90: "rgba(51, 95, 112, 0.9)";
        readonly 95: "rgba(51, 95, 112, 0.95)";
      };
      readonly 500: {
        readonly 5: "rgba(59, 130, 246, 0.05)";
        readonly 8: "rgba(59, 130, 246, 0.08)";
        readonly 10: "rgba(59, 130, 246, 0.1)";
        readonly 15: "rgba(59, 130, 246, 0.15)";
        readonly 25: "rgba(59, 130, 246, 0.25)";
        readonly 30: "rgba(59, 130, 246, 0.3)";
        readonly 40: "rgba(59, 130, 246, 0.4)";
        readonly 60: "rgba(59, 130, 246, 0.6)";
      };
      readonly 600: {
        readonly 4: "rgba(10, 61, 80, 0.04)";
        readonly 20: "rgba(10, 61, 80, 0.2)";
      };
      readonly 650: {
        readonly 70: "rgba(10, 34, 48, 0.7)";
        readonly 85: "rgba(10, 34, 48, 0.85)";
      };
      readonly 700: {
        readonly 3: "rgba(42, 65, 89, 0.03)";
      };
      readonly 800: {
        readonly 1: "rgba(11, 107, 203, 0.01)";
        readonly 2: "rgba(11, 107, 203, 0.02)";
        readonly 5: "rgba(11, 107, 203, 0.05)";
        readonly 8: "rgba(11, 107, 203, 0.08)";
        readonly 10: "rgba(11, 107, 203, 0.1)";
        readonly 12: "rgba(11, 107, 203, 0.12)";
        readonly 15: "rgba(11, 107, 203, 0.15)";
        readonly 20: "rgba(11, 107, 203, 0.2)";
        readonly 25: "rgba(11, 107, 203, 0.25)";
        readonly 50: "rgba(11, 107, 203, 0.5)";
      };
    };
    gray: {
      readonly 0: {
        readonly 20: "rgba(255, 255, 255, 0.2)";
        readonly 50: "rgba(255, 255, 255, 0.5)";
      };
      readonly 5: {
        readonly 98: "rgba(241, 245, 249, 0.98)";
      };
      readonly 15: {
        readonly 90: "rgba(248, 250, 252, 0.9)";
        readonly 95: "rgba(248, 250, 252, 0.95)";
        readonly 96: "rgba(248, 250, 252, 0.96)";
      };
      readonly 150: {
        readonly 10: "rgba(190, 209, 223, 0.1)";
        readonly 20: "rgba(190, 209, 223, 0.2)";
        readonly 30: "rgba(190, 209, 223, 0.3)";
        readonly 50: "rgba(190, 209, 223, 0.5)";
        readonly 80: "rgba(190, 209, 223, 0.8)";
      };
      readonly 160: {
        readonly 50: "rgba(201, 203, 205, 0.5)";
      };
      readonly 175: {
        readonly 12: "rgba(224, 224, 224, 0.12)";
      };
      readonly 200: {
        readonly 20: "rgba(211, 223, 232, 0.2)";
        readonly 50: "rgba(211, 223, 232, 0.5)";
        readonly 60: "rgba(211, 223, 232, 0.6)";
      };
      readonly 210: {
        readonly 50: "rgba(211, 228, 244, 0.5)";
      };
      readonly 600: {
        readonly 3: "rgba(115, 123, 130, 0.03)";
      };
      readonly 668: {
        readonly 16: "rgba(128, 128, 128, 0.16)";
      };
      readonly 670: {
        readonly 16: "rgba(136, 136, 136, 0.16)";
      };
      readonly 690: {
        readonly 15: "rgba(107, 114, 128, 0.15)";
        readonly 40: "rgba(107, 114, 128, 0.4)";
      };
      readonly 700: {
        readonly 50: "rgba(48, 54, 58, 0.5)";
      };
      readonly 710: {
        readonly 50: "rgba(50, 56, 62, 0.5)";
      };
      readonly 725: {
        readonly 30: "rgba(55, 65, 81, 0.3)";
        readonly 50: "rgba(55, 65, 81, 0.5)";
      };
      readonly 775: {
        readonly 25: "rgba(42, 44, 56, 0.25)";
        readonly 30: "rgba(42, 44, 56, 0.3)";
        readonly 50: "rgba(42, 44, 56, 0.5)";
        readonly 60: "rgba(42, 44, 56, 0.6)";
        readonly 70: "rgba(42, 44, 56, 0.7)";
      };
      readonly 780: {
        readonly 72: "rgba(30, 41, 59, 0.72)";
      };
      readonly 800: {
        readonly 8: "rgba(44, 49, 53, 0.08)";
        readonly 50: "rgba(44, 49, 53, 0.5)";
      };
      readonly 875: {
        readonly 50: "rgba(16, 17, 17, 0.5)";
      };
    };
    green: {
      readonly 375: {
        readonly 15: "rgba(52, 211, 153, 0.15)";
        readonly 22: "rgba(52, 211, 153, 0.22)";
        readonly 28: "rgba(52, 211, 153, 0.28)";
      };
      readonly 400: {
        readonly 40: "rgba(16, 185, 129, 0.4)";
      };
      readonly 500: {
        readonly 2: "rgba(34, 197, 94, 0.02)";
        readonly 15: "rgba(34, 197, 94, 0.15)";
      };
      readonly 600: {
        readonly 12: "rgba(76, 175, 80, 0.12)";
      };
      readonly 800: {
        readonly 2: "rgba(31, 184, 75, 0.02)";
        readonly 4: "rgba(31, 184, 75, 0.04)";
        readonly 5: "rgba(31, 184, 75, 0.05)";
        readonly 6: "rgba(31, 184, 75, 0.06)";
        readonly 8: "rgba(31, 184, 75, 0.08)";
        readonly 10: "rgba(31, 184, 75, 0.1)";
        readonly 15: "rgba(31, 184, 75, 0.15)";
        readonly 20: "rgba(31, 184, 75, 0.2)";
        readonly 30: "rgba(31, 184, 75, 0.3)";
        readonly 50: "rgba(31, 184, 75, 0.5)";
      };
      readonly 900: {
        readonly 5: "rgba(30, 122, 32, 0.05)";
      };
      readonly 950: {
        readonly 20: "rgba(22, 114, 48, 0.2)";
        readonly 40: "rgba(22, 114, 48, 0.4)";
      };
    };
    teal: {
      readonly custom: {
        readonly 5: "rgba(92, 184, 166, 0.05)";
      };
    };
    white: {
      readonly 0: {
        readonly 5: "rgba(255, 255, 255, 0.05)";
        readonly 10: "rgba(255, 255, 255, 0.1)";
        readonly 12: "rgba(255, 255, 255, 0.12)";
        readonly 20: "rgba(255, 255, 255, 0.2)";
        readonly 30: "rgba(255, 255, 255, 0.3)";
        readonly 50: "rgba(255, 255, 255, 0.5)";
        readonly 70: "rgba(255, 255, 255, 0.7)";
        readonly 80: "rgba(255, 255, 255, 0.8)";
        readonly 90: "rgba(255, 255, 255, 0.9)";
        readonly 95: "rgba(255, 255, 255, 0.95)";
        readonly 96: "rgba(255, 255, 255, 0.96)";
        readonly 98: "rgba(255, 255, 255, 0.98)";
      };
    };
    black: {
      readonly 0: {
        readonly 1: "rgba(0, 0, 0, 0.01)";
        readonly 2: "rgba(0, 0, 0, 0.02)";
        readonly 3: "rgba(0, 0, 0, 0.03)";
        readonly 4: "rgba(0, 0, 0, 0.04)";
        readonly 5: "rgba(0, 0, 0, 0.05)";
        readonly 6: "rgba(0, 0, 0, 0.06)";
        readonly 8: "rgba(0, 0, 0, 0.08)";
        readonly 10: "rgba(0, 0, 0, 0.1)";
        readonly 12: "rgba(0, 0, 0, 0.12)";
        readonly 15: "rgba(0, 0, 0, 0.15)";
        readonly 18: "rgba(0, 0, 0, 0.18)";
        readonly 20: "rgba(0, 0, 0, 0.2)";
        readonly 25: "rgba(0, 0, 0, 0.25)";
        readonly 30: "rgba(0, 0, 0, 0.3)";
        readonly 50: "rgba(0, 0, 0, 0.5)";
      };
    };
    red: {
      readonly 325: {
        readonly 8: "rgba(234, 61, 61, 0.08)";
        readonly 50: "rgba(234, 61, 61, 0.5)";
      };
      readonly 400: {
        readonly 15: "rgba(239, 68, 68, 0.15)";
        readonly 22: "rgba(239, 68, 68, 0.22)";
        readonly 28: "rgba(239, 68, 68, 0.28)";
        readonly 40: "rgba(239, 68, 68, 0.4)";
      };
      readonly 450: {
        readonly 10: "rgba(255, 107, 107, 0.1)";
      };
      readonly 600: {
        readonly 10: "rgba(218, 49, 49, 0.1)";
        readonly 20: "rgba(218, 49, 49, 0.2)";
      };
    };
    purple: {
      readonly 325: {
        readonly 20: "rgba(165, 180, 252, 0.2)";
      };
      readonly 500: {
        readonly 2: "rgba(139, 92, 246, 0.02)";
        readonly 5: "rgba(139, 92, 246, 0.05)";
        readonly 8: "rgba(139, 92, 246, 0.08)";
        readonly 15: "rgba(139, 92, 246, 0.15)";
        readonly 40: "rgba(139, 92, 246, 0.4)";
      };
      readonly 550: {
        readonly 5: "rgba(147, 51, 234, 0.05)";
        readonly 8: "rgba(147, 51, 234, 0.08)";
      };
    };
    orange: {
      readonly 350: {
        readonly 10: "rgba(255, 172, 88, 0.1)";
      };
      readonly 375: {
        readonly 2: "rgba(251, 146, 60, 0.02)";
        readonly 15: "rgba(251, 146, 60, 0.15)";
        readonly 22: "rgba(251, 146, 60, 0.22)";
        readonly 28: "rgba(251, 146, 60, 0.28)";
      };
      readonly 450: {
        readonly 15: "rgba(255, 165, 0, 0.15)";
        readonly 22: "rgba(255, 165, 0, 0.22)";
        readonly 28: "rgba(255, 165, 0, 0.28)";
      };
      readonly 550: {
        readonly 15: "rgba(245, 158, 11, 0.15)";
        readonly 40: "rgba(245, 158, 11, 0.4)";
      };
    };
    cyan: {
      readonly 400: {
        readonly 40: "rgba(6, 182, 212, 0.4)";
      };
      readonly 600: {
        readonly 70: "rgba(0, 255, 255, 0.7)";
      };
    };
    pink: {
      readonly 400: {
        readonly 40: "rgba(236, 72, 153, 0.4)";
      };
    };
    blue: {
      readonly 650: {
        readonly 2: "rgba(13, 110, 253, 0.02)";
        readonly 15: "rgba(13, 110, 253, 0.15)";
        readonly 25: "rgba(13, 110, 253, 0.25)";
        readonly 50: "rgba(13, 110, 253, 0.5)";
        readonly 75: "rgba(13, 110, 253, 0.75)";
      };
    };
    gold: {
      readonly 400: {
        readonly 10: "rgba(255, 215, 0, 0.1)";
        readonly 20: "rgba(255, 215, 0, 0.2)";
        readonly 30: "rgba(255, 215, 0, 0.3)";
        readonly 40: "rgba(255, 215, 0, 0.4)";
        readonly 50: "rgba(255, 215, 0, 0.5)";
        readonly 60: "rgba(255, 215, 0, 0.6)";
        readonly 70: "rgba(255, 215, 0, 0.7)";
        readonly 80: "rgba(255, 215, 0, 0.8)";
        readonly 90: "rgba(255, 215, 0, 0.9)";
        readonly 100: "#ffd700";
      };
    };
  };
  unique: {
    softHoverColor: string;
    solidDisabledColor: string;
    scrollbar: string;
    lightBlue: string;
    limeGreen: string;
    mediumGray: string;
    tealPreview: string;
    almostBlack: string;
    lightBlueOverlay: string;
    lightGrayBackground: string;
  };
};
//#endregion
//#region src/tokens/schemes.d.ts
declare const darkScheme: SemanticColorScheme;
declare const lightScheme: SemanticColorScheme;
//#endregion
//#region src/tokens/typography.d.ts
declare const typography: {
  fontFamily: {
    body: string;
    display: string;
  };
  fontSize: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    xl2: string;
    xl3: string;
    xl4: string;
  };
  fontWeight: {
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  lineHeight: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
  };
};
//#endregion
//#region src/tokens/metrics.d.ts
declare const spacing: {
  unit: number;
};
declare const radii: {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
};
declare const shadows: {
  channel: string;
  opacity: number;
  levels: {
    xs: {
      offsetX: number;
      offsetY: number;
      blur: number;
      spread: number;
    }[];
    sm: {
      offsetX: number;
      offsetY: number;
      blur: number;
      spread: number;
    }[];
    md: {
      offsetX: number;
      offsetY: number;
      blur: number;
      spread: number;
    }[];
    lg: {
      offsetX: number;
      offsetY: number;
      blur: number;
      spread: number;
    }[];
    xl: {
      offsetX: number;
      offsetY: number;
      blur: number;
      spread: number;
    }[];
  };
};
declare const motion: {
  duration: {
    fast: number;
    standard: number;
    slow: number;
    slower: number;
  };
};
//#endregion
//#region src/tokens/index.d.ts
/**
 * The canonical token set, validated at module load so a malformed token
 * fails fast at build/test time rather than rendering wrong.
 */
declare const designTokens: DesignTokens;
//#endregion
//#region src/emitters/types.d.ts
/**
 * A named emit target. Every platform output (web theme fragment, CSS
 * variables, future native formats) implements this interface; adding a
 * target is adding one implementation, nothing in the token source changes.
 */
type TokenEmitter<TOutput> = {
  /** Unique target name, e.g. "joy" or "css-variables". */
  readonly target: string;
  emit(tokens: DesignTokens): TOutput;
};
//#endregion
//#region src/emitters/joy.d.ts
type JoyPaletteFragment = {
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
type JoyThemeFragment = {
  colorSchemes: {
    light: {
      palette: JoyPaletteFragment;
    };
    dark: {
      palette: JoyPaletteFragment;
    };
  };
  fontFamily: DesignTokens['typography']['fontFamily'];
  borderRadius: number;
};
declare const emitJoyThemeFragment: (tokens: DesignTokens) => JoyThemeFragment;
declare const joyEmitter: TokenEmitter<JoyThemeFragment>;
//#endregion
//#region src/emitters/cssVariables.d.ts
declare const emitCssVariables: (tokens: DesignTokens) => string;
declare const cssVariablesEmitter: TokenEmitter<string>;
//#endregion
//#region src/emitters/index.d.ts
/** Registry of the available emit targets, keyed by target name. */
declare const emitters: {
  readonly [joyEmitter.target]: TokenEmitter<JoyThemeFragment>;
  readonly [cssVariablesEmitter.target]: TokenEmitter<string>;
};
//#endregion
export { ColorSchemeMode, ColorValue, DesignTokens, HexColor, InteractionTones, type JoyPaletteFragment, type JoyThemeFragment, SemanticColorScheme, type TokenEmitter, alphaRampSchema, blackAlpha, blue, blueAlpha, brand, brandAlpha, colorPrimitives, colorPrimitivesSchema, colorRampSchema, colorValueSchema, cssValueSchema, cssVariablesEmitter, cyan, cyanAlpha, darkScheme, designTokens, designTokensSchema, emitCssVariables, emitJoyThemeFragment, emitters, gold, goldAlpha, gray, grayAlpha, green, greenAlpha, hexColorSchema, interactionTonesSchema, joyEmitter, lightScheme, motion, motionSchema, orange, orangeAlpha, pink, pinkAlpha, purple, purpleAlpha, radii, radiiSchema, red, redAlpha, rgbaColorSchema, semanticColorSchemeSchema, shadows, shadowsSchema, spacing, spacingSchema, teal, tealAlpha, tokenReferenceSchema, typography, typographySchema, unique, whiteAlpha };
//# sourceMappingURL=index.d.mts.map