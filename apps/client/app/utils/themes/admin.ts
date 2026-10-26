export type AdminStatusTone = 'good' | 'info' | 'warn' | 'bad' | 'neutral';
export type AdminPalette = {
  canvas: string;
  surface: string;
  /** Table headers, row hover and dialog bodies: one step off `surface`. */
  surfaceSubtle: string;
  border: string;
  /** Row and in-card dividers, quieter than `border`. */
  hairline: string;
  /** Outline of buttons, inputs and selects. */
  controlBorder: string;
  /** Fill behind a hovered ghost button, icon button or menu item. */
  hover: string;
  ink: string;
  inkMuted: string;
  accent: string;
  danger: string;
  status: Record<AdminStatusTone, { foreground: string; background: string }>;
};

export const adminPalette = {
  light: {
    canvas: '#F6F6F4',
    surface: '#FFFFFF',
    surfaceSubtle: '#FAFAF8',
    border: '#E4E4DF',
    hairline: '#EFEFEB',
    controlBorder: '#D9D9D4',
    hover: '#ECECE8',
    ink: '#18181B',
    inkMuted: '#62626B',
    accent: '#4F46E5',
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
    border: '#45454D',
    hairline: '#2E2E34',
    controlBorder: '#55555E',
    hover: '#2E2E34',
    ink: '#FAFAFA',
    inkMuted: '#B4B4BE',
    accent: '#A5B4FC',
    danger: '#FCA5A5',
    status: {
      good: { foreground: '#BBF7D0', background: '#14532D' },
      info: { foreground: '#BFDBFE', background: '#1E3A8A' },
      warn: { foreground: '#FEF08A', background: '#713F12' },
      bad: { foreground: '#FECACA', background: '#7F1D1D' },
      neutral: { foreground: '#E4E4E7', background: '#3F3F46' },
    },
  },
} satisfies Record<'light' | 'dark', AdminPalette>;
