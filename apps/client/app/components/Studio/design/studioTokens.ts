/**
 * Creative Studio design tokens: the dark studio surface from the approved Studio mock, with a light
 * counterpart built from the same roles. They exist only as `--studio-*` CSS variables declared by
 * StudioThemeScope, so nothing outside a Studio route can read them.
 */

export type StudioColorMode = 'light' | 'dark';

const STUDIO_COLOR_ROLES = [
  // Surfaces, back to front.
  'canvas',
  'sunken',
  'surface',
  'raised',
  'hover',
  'selected',
  'scrim',
  // Lines.
  'hairline',
  'border',
  'border-strong',
  // Text.
  'text-strong',
  'text',
  'text-secondary',
  'text-muted',
  // The one accent.
  'accent',
  'accent-hover',
  'accent-contrast',
  'accent-bright',
  'accent-soft',
  'accent-border',
  'accent-on-soft',
  'link',
  'focus-ring',
  // Warm status.
  'star',
  'success',
  'success-soft',
  'success-border',
  'warning',
  'warning-soft',
  'warning-border',
  'danger',
  'danger-soft',
  'danger-border',
] as const;

export type StudioColorRole = (typeof STUDIO_COLOR_ROLES)[number];

type StudioPalette = Record<StudioColorRole, string>;

export const STUDIO_PALETTES: Record<StudioColorMode, StudioPalette> = {
  dark: {
    canvas: '#0E1013',
    sunken: '#0B0D10',
    surface: '#151820',
    raised: '#1A1F27',
    hover: '#1E232A',
    selected: '#252B33',
    scrim: 'rgba(14, 16, 19, 0.86)',
    hairline: '#1F242B',
    border: '#2A2F37',
    'border-strong': '#343B45',
    'text-strong': '#F2F4F6',
    text: '#E7E9EC',
    'text-secondary': '#AEB6C0',
    'text-muted': '#8E97A3',
    accent: '#0B6BCB',
    'accent-hover': '#1A7BDD',
    'accent-contrast': '#FFFFFF',
    'accent-bright': '#4C9AFF',
    'accent-soft': '#13243A',
    'accent-border': '#2F6FB5',
    'accent-on-soft': '#DCEBFF',
    link: '#7DB5FF',
    'focus-ring': '#4C9AFF',
    star: '#F5B83D',
    success: '#9BE2B0',
    'success-soft': '#17251C',
    'success-border': '#2E5A3C',
    warning: '#F5C58A',
    'warning-soft': '#33261A',
    'warning-border': '#6B4A22',
    danger: '#F4A3A3',
    'danger-soft': '#33191B',
    'danger-border': '#6E2E33',
  },
  // Paper-white surfaces on a cool grey canvas; the accent and the warm statuses darken to keep contrast.
  light: {
    canvas: '#F4F5F7',
    sunken: '#ECEEF1',
    surface: '#FFFFFF',
    raised: '#F7F8FA',
    hover: '#EEF0F3',
    selected: '#FFFFFF',
    scrim: 'rgba(255, 255, 255, 0.9)',
    hairline: '#E2E5E9',
    border: '#D6DAE0',
    'border-strong': '#C2C8D0',
    'text-strong': '#0B0D10',
    text: '#171A1F',
    'text-secondary': '#4B535E',
    'text-muted': '#69727E',
    accent: '#0B6BCB',
    'accent-hover': '#0A5DB0',
    'accent-contrast': '#FFFFFF',
    'accent-bright': '#0B6BCB',
    'accent-soft': '#E7F0FB',
    'accent-border': '#8DB9EA',
    'accent-on-soft': '#0A4F96',
    link: '#0B6BCB',
    'focus-ring': '#0B6BCB',
    star: '#C98A0E',
    success: '#1E7A3E',
    'success-soft': '#E8F6ED',
    'success-border': '#A9DDBA',
    warning: '#8A5A12',
    'warning-soft': '#FBF1E2',
    'warning-border': '#E8C493',
    danger: '#B42318',
    'danger-soft': '#FDECEA',
    'danger-border': '#F2B8B2',
  },
};

// Generous radii: controls at 8-10, panels at 14, chips fully round.
export const STUDIO_RADII = { xs: '6px', sm: '8px', md: '10px', lg: '12px', xl: '14px', pill: '999px' } as const;
export type StudioRadius = keyof typeof STUDIO_RADII;

// Both faces are already loaded app-wide by next/font in app/layout.tsx; Libre Franklin is the html font.
export const STUDIO_FONTS = {
  ui: 'var(--font-reading-sans), "Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'var(--font-reading-mono), "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

const colorVariableName = (role: StudioColorRole) => `--studio-${role}`;

/** A Studio color as a CSS value, e.g. `studioColor('canvas')` is `var(--studio-canvas)`. */
export const studioColor = (role: StudioColorRole) => `var(${colorVariableName(role)})`;

export const studioRadius = (radius: StudioRadius) => `var(--studio-radius-${radius})`;

export const studioFont = (face: keyof typeof STUDIO_FONTS) => `var(--studio-font-${face})`;

/** Every `--studio-*` declaration for one mode; StudioThemeScope applies it to its root. */
export const studioCssVariables = (mode: StudioColorMode): Record<string, string> => {
  const palette = STUDIO_PALETTES[mode];
  const colors = Object.fromEntries(STUDIO_COLOR_ROLES.map(role => [colorVariableName(role), palette[role]]));
  const radii = Object.fromEntries(
    Object.entries(STUDIO_RADII).map(([name, value]) => [`--studio-radius-${name}`, value])
  );
  const fonts = Object.fromEntries(
    Object.entries(STUDIO_FONTS).map(([name, value]) => [`--studio-font-${name}`, value])
  );
  return { ...colors, ...radii, ...fonts };
};

/** The uppercase, letter-spaced micro-label the mock uses for every section head. */
export const STUDIO_MICRO_LABEL = {
  fontFamily: studioFont('ui'),
  fontSize: '11px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: studioColor('text-muted'),
} as const;

/** The focus ring every interactive Studio primitive shares. */
export const STUDIO_FOCUS_VISIBLE = {
  outline: `2px solid ${studioColor('focus-ring')}`,
  outlineOffset: '2px',
} as const;
