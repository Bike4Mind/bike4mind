import type { ColorSchemeMode, DesignTokens } from '../../schema';

// The platform-neutral model every native emitter (Swift today, Kotlin next)
// renders from. It resolves the token source to literal values once, so the
// per-language emitters are pure formatting and cannot disagree on a color.
//
// The color roles are the native apps' vocabulary. Each one names the web
// source it mirrors, so a role reads the same tokens the web theme does.

/** An sRGB color: 0-255 channels plus a 0-1 alpha. */
export type Rgba = {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
};

/** Where a role's color comes from in the token source, per mode. */
export type ColorSource =
  /** A semantic scheme key, e.g. "background.body" or "divider". */
  | { readonly scheme: string }
  /** A primitive ramp stop, e.g. brand 800. */
  | { readonly ramp: string; readonly stop: string }
  /** A pre-materialized alpha variant, e.g. brand 100 at 70%. */
  | { readonly alphaOf: string; readonly stop: string; readonly percent: string };

export type ColorRoleSpec = {
  readonly name: string;
  readonly description: string;
  readonly light: ColorSource;
  readonly dark: ColorSource;
};

export type NativeColorRole = {
  readonly name: string;
  readonly description: string;
  readonly light: Rgba;
  readonly dark: Rgba;
};

export type NamedValue = { readonly name: string; readonly value: number };

export type NativeTheme = {
  readonly colors: readonly NativeColorRole[];
  /** The role stock controls tint with (the platform's accent / primary color). */
  readonly accentRole: NativeColorRole;
  readonly spacing: readonly NamedValue[];
  /** Corner radii in points/dp. */
  readonly radii: readonly NamedValue[];
  readonly typography: {
    /** The first family of the body stack, e.g. "Libre Franklin". */
    readonly familyName: string;
    /** Sizes in points/dp (1rem = 16). */
    readonly sizes: readonly NamedValue[];
    /** CSS weights, 100-1000. */
    readonly weights: readonly NamedValue[];
    /** Unitless multipliers of the font size. */
    readonly lineHeights: readonly NamedValue[];
  };
};

const REM_IN_POINTS = 16;

/**
 * Spacing steps as multiples of the spacing unit. The web theme takes any
 * multiple through spacing(n); native code needs a fixed, named set.
 */
export const SPACING_STEPS: readonly NamedValue[] = [
  { name: 'xs', value: 0.5 },
  { name: 's', value: 1 },
  { name: 'm', value: 2 },
  { name: 'l', value: 3 },
  { name: 'xl', value: 4 },
  { name: 'xxl', value: 6 },
];

const scheme = (path: string): ColorSource => ({ scheme: path });
const ramp = (name: string, stop: string): ColorSource => ({ ramp: name, stop });

/**
 * The native color roles. Web sources live in apps/client/app/utils/themes
 * (the schemes here, plus the chatbox and reading component palettes, which
 * this list reads at the primitive level). Keep each role pointing at the same
 * primitive as its web source.
 */
export const NATIVE_COLOR_ROLES: readonly ColorRoleSpec[] = [
  {
    name: 'accent',
    description: 'Interactive accent: links, focus, stock control tint (web reading.accent).',
    light: ramp('brand', '800'),
    dark: ramp('blue', '550'),
  },
  {
    name: 'backgroundBody',
    description: 'Screen background (web background.body).',
    light: scheme('background.body'),
    dark: scheme('background.body'),
  },
  {
    name: 'surface',
    description: 'Raised surface: cards and grouped rows (web background.surface2).',
    light: scheme('background.surface2'),
    dark: scheme('background.surface2'),
  },
  {
    name: 'panel',
    description: 'The composer bar fill (web background.panel, SessionBottom).',
    light: scheme('background.panel'),
    dark: scheme('background.panel'),
  },
  {
    name: 'promptBubble',
    description: "The user's prompt bubble fill (web UserPrompt: gray[50] light, background.panel dark).",
    light: ramp('gray', '50'),
    dark: scheme('background.panel'),
  },
  {
    name: 'borderSoft',
    description: 'Hairline around the prompt bubble (web border.soft).',
    light: scheme('border.soft'),
    dark: scheme('border.soft'),
  },
  {
    name: 'borderSolid',
    description: 'Composer bar edge (web border.solid).',
    light: scheme('border.solid'),
    dark: scheme('border.solid'),
  },
  {
    name: 'divider',
    description: 'Hairline dividers (web divider).',
    light: scheme('divider'),
    dark: scheme('divider'),
  },
  {
    name: 'textPrimary',
    description: 'Primary ink (web text.primary).',
    light: scheme('text.primary'),
    dark: scheme('text.primary'),
  },
  {
    name: 'textSecondary',
    description: 'Secondary ink (web text.tertiary: the visible step below primary).',
    light: scheme('text.tertiary'),
    dark: scheme('text.tertiary'),
  },
  {
    name: 'readingInk',
    description: 'Body prose of an assistant reply (web reading.ink2).',
    light: { alphaOf: 'brand', stop: '650', percent: '85' },
    dark: { alphaOf: 'brand', stop: '100', percent: '85' },
  },
  {
    name: 'composerPlaceholder',
    description: 'Composer placeholder ink, drawn at 75% opacity (web chatbox.messageInputColor).',
    light: ramp('brand', '600'),
    dark: ramp('gray', '200'),
  },
  {
    name: 'sendButton',
    description: 'Send button fill (web primary solidBg: blue[600] light, the Joy default primary 500 dark).',
    light: ramp('blue', '600'),
    dark: ramp('brand', '800'),
  },
  {
    name: 'codeSurface',
    description: 'Code panel fill inside a reply (web reading.surface).',
    light: ramp('gray', '0'),
    dark: ramp('gray', '850'),
  },
  {
    name: 'codeFrame',
    description: 'Code block frame edge (web reading.cardLine).',
    light: { alphaOf: 'brand', stop: '800', percent: '20' },
    dark: { alphaOf: 'brand', stop: '500', percent: '18' },
  },
  {
    name: 'sidebar',
    description: 'Navigation drawer background (web sidenav pinned backdrop).',
    light: ramp('gray', '50'),
    dark: ramp('gray', '850'),
  },
  {
    name: 'sidebarText',
    description: 'Navigation drawer row ink (web sidenav item text).',
    light: ramp('brand', '600'),
    dark: ramp('gray', '200'),
  },
  {
    name: 'sidebarSelected',
    description: 'Selected drawer row (web notebooklist focusedBackground).',
    light: { alphaOf: 'brand', stop: '100', percent: '50' },
    dark: { alphaOf: 'gray', stop: '775', percent: '70' },
  },
  {
    name: 'destructive',
    description: 'Destructive red (web danger.solidBg light, danger.mainChannel dark).',
    light: scheme('danger.solidBackground'),
    dark: scheme('danger.main'),
  },
  {
    name: 'warning',
    description: 'Warning orange (web warning.solidBg).',
    light: scheme('warning.solidBackground'),
    dark: scheme('warning.solidBackground'),
  },
  {
    name: 'success',
    description: 'Success green (web success.solidBg light, success.softColor dark).',
    light: scheme('success.solidBackground'),
    dark: scheme('success.subtleText'),
  },
];

export const parseColor = (value: string): Rgba => {
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    const expanded = digits.length <= 4 ? [...digits].map(digit => digit + digit).join('') : digits;
    if (expanded.length !== 6 && expanded.length !== 8) throw new Error(`Unsupported hex color "${value}"`);
    const channel = (index: number): number => Number.parseInt(expanded.slice(index * 2, index * 2 + 2), 16);
    return {
      red: channel(0),
      green: channel(1),
      blue: channel(2),
      alpha: expanded.length === 8 ? Math.round((channel(3) / 255) * 1000) / 1000 : 1,
    };
  }
  const rgba = /^rgba?\((\d{1,3}), (\d{1,3}), (\d{1,3})(?:, ([\d.]+))?\)$/.exec(value);
  if (rgba) {
    return {
      red: Number(rgba[1]),
      green: Number(rgba[2]),
      blue: Number(rgba[3]),
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`Unsupported color "${value}": native targets need a literal hex or rgba() color`);
};

const lookup = (record: Readonly<Record<string, unknown>>, key: string, context: string): unknown => {
  if (!Object.hasOwn(record, key)) throw new Error(`Unknown token ${context}`);
  return record[key];
};

const resolveSource = (tokens: DesignTokens, mode: ColorSchemeMode, source: ColorSource): Rgba => {
  if ('scheme' in source) {
    let node: unknown = tokens.color.schemes[mode];
    for (const segment of source.scheme.split('.')) {
      if (typeof node !== 'object' || node === null) break;
      node = lookup(node as Record<string, unknown>, segment, `"${source.scheme}" in the ${mode} scheme`);
    }
    if (typeof node !== 'string') throw new Error(`Scheme key "${source.scheme}" (${mode}) is not a color`);
    return parseColor(node);
  }
  const { primitives } = tokens.color;
  if ('ramp' in source) {
    const rampValues = lookup(primitives.ramps, source.ramp, `ramp "${source.ramp}"`) as Record<string, string>;
    return parseColor(lookup(rampValues, source.stop, `stop ${source.ramp}.${source.stop}`) as string);
  }
  const alphaRamp = lookup(primitives.alphas, source.alphaOf, `alpha ramp "${source.alphaOf}"`) as Record<
    string,
    Record<string, string>
  >;
  const stop = lookup(alphaRamp, source.stop, `alpha stop ${source.alphaOf}.${source.stop}`) as Record<string, string>;
  return parseColor(
    lookup(stop, source.percent, `alpha ${source.alphaOf}.${source.stop} at ${source.percent}%`) as string
  );
};

/** The first family of a CSS font stack, unquoted. */
export const primaryFamilyName = (stack: string): string => {
  const first = stack.split(',')[0]?.trim() ?? '';
  const name = first.replace(/^["']|["']$/g, '');
  if (!name) throw new Error(`Font stack "${stack}" has no family`);
  return name;
};

const remToPoints = (rem: string): number => Number.parseFloat(rem) * REM_IN_POINTS;

export const resolveNativeTheme = (
  tokens: DesignTokens,
  roles: readonly ColorRoleSpec[] = NATIVE_COLOR_ROLES
): NativeTheme => {
  const colors = roles.map(role => ({
    name: role.name,
    description: role.description,
    light: resolveSource(tokens, 'light', role.light),
    dark: resolveSource(tokens, 'dark', role.dark),
  }));
  const accentRole = colors.find(role => role.name === 'accent');
  if (!accentRole) throw new Error('Native color roles must define "accent"');
  return {
    colors,
    accentRole,
    spacing: SPACING_STEPS.map(step => ({ name: step.name, value: step.value * tokens.spacing.unit })),
    radii: Object.entries(tokens.radii).map(([name, value]) => ({ name, value })),
    typography: {
      familyName: primaryFamilyName(tokens.typography.fontFamily.body),
      sizes: Object.entries(tokens.typography.fontSize).map(([name, rem]) => ({ name, value: remToPoints(rem) })),
      weights: Object.entries(tokens.typography.fontWeight).map(([name, value]) => ({ name, value })),
      lineHeights: Object.entries(tokens.typography.lineHeight).map(([name, value]) => ({
        name,
        value: Number(value),
      })),
    },
  };
};
