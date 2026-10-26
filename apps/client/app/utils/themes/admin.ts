export type AdminStatusTone = 'good' | 'info' | 'warn' | 'bad' | 'neutral';
export type AdminPalette = {
  canvas: string;
  surface: string;
  border: string;
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
    border: '#E4E4DF',
    ink: '#18181B',
    inkMuted: '#62626B',
    accent: '#4F46E5',
    danger: '#B42318',
    status: {
      good: { foreground: '#166534', background: '#DCFCE7' },
      info: { foreground: '#1E40AF', background: '#DBEAFE' },
      warn: { foreground: '#854D0E', background: '#FEF9C3' },
      bad: { foreground: '#991B1B', background: '#FEE2E2' },
      neutral: { foreground: '#3F3F46', background: '#F4F4F5' },
    },
  },
  dark: {
    canvas: '#141416',
    surface: '#1E1E22',
    border: '#45454D',
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
