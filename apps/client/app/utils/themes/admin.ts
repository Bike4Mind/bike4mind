export type AdminStatusTone = 'good' | 'info' | 'warn' | 'bad' | 'neutral';

/** The admin color tokens. `components/admin/DESIGN_GUIDE.md` section 2 is the spec; keep the two in sync. */
export type AdminPalette = {
  canvas: string;
  surface: string;
  /** Table header and row hover: one step off `surface`. */
  surfaceSubtle: string;
  /** Fill behind a hovered nav item, ghost button or chip. */
  hover: string;
  border: string;
  /** Outline of buttons, inputs and selects. */
  borderStrong: string;
  ink: string;
  inkSecondary: string;
  inkMuted: string;
  accent: string;
  link: string;
  /** Selected row and set filter chip. */
  selection: { background: string; border: string; foreground: string };
  danger: string;
  status: Record<AdminStatusTone, { foreground: string; background: string }>;
};

export const adminPalette = {
  light: {
    canvas: '#F6F6F4',
    surface: '#FFFFFF',
    surfaceSubtle: '#FAFAF8',
    hover: '#ECECE8',
    border: '#E4E4DF',
    borderStrong: '#D9D9D4',
    ink: '#18181B',
    inkSecondary: '#3F3F46',
    inkMuted: '#62626B',
    accent: '#4F46E5',
    link: '#3F3BC9',
    selection: { background: '#F3F2FE', border: '#C7C4F7', foreground: '#2B27A3' },
    danger: '#B42318',
    status: {
      good: { foreground: '#166534', background: '#E7F5EC' },
      info: { foreground: '#3730A3', background: '#E8EEFF' },
      warn: { foreground: '#8A4B00', background: '#FFF1DE' },
      bad: { foreground: '#9F1C12', background: '#FDECEA' },
      neutral: { foreground: '#52525B', background: '#F1F1EE' },
    },
  },
  dark: {
    canvas: '#141416',
    surface: '#1E1E22',
    surfaceSubtle: '#232328',
    hover: '#2A2A30',
    border: '#2E2E34',
    borderStrong: '#45454D',
    ink: '#FAFAFA',
    inkSecondary: '#D4D4D8',
    inkMuted: '#B4B4BE',
    accent: '#A5B4FC',
    link: '#A5B4FC',
    selection: { background: '#26244A', border: '#4B47A8', foreground: '#C7C4F7' },
    danger: '#FCA5A5',
    status: {
      good: { foreground: '#BBF7D0', background: '#14532D' },
      info: { foreground: '#C7D2FE', background: '#312E81' },
      warn: { foreground: '#FED7AA', background: '#7C2D12' },
      bad: { foreground: '#FECACA', background: '#7F1D1D' },
      neutral: { foreground: '#E4E4E7', background: '#3F3F46' },
    },
  },
} satisfies Record<'light' | 'dark', AdminPalette>;

export type DeploymentEnvironment = 'local' | 'staging' | 'preview' | 'production' | 'unknown';

/**
 * The environment banner's fills, one per environment and the same in light and dark: the strip
 * sits above the admin surface, on every color scheme. Muted on purpose, so it names the
 * environment without being the loudest thing on screen; each passes 4.5:1 (contrast.test.ts).
 */
export const environmentBannerPalette = {
  foreground: '#F4F4F5',
  background: {
    local: '#2F5E48',
    staging: '#3B4472',
    preview: '#56457A',
    production: '#8B3A3A',
    unknown: '#6B5A1E',
  },
} satisfies { foreground: string; background: Record<DeploymentEnvironment, string> };
