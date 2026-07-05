import '@mui/joy/styles';

/**
 * Custom color range for security severity levels
 * Includes standard MUI properties plus custom gradient/shadow values
 */
export interface SecurityColorRange {
  solidBg: string;
  solidColor: string;
  plainColor: string;
  plainHoverBg: string;
  outlinedBorder: string;
  outlinedColor: string;
  outlinedHoverBg: string;
  softBg: string;
  softColor: string;
  softHoverBg: string;
  gradientStart: string;
  gradientEnd: string;
  shadow: string;
}

/**
 * MUI Joy Theme Type Extensions
 * 
 * Extends MUI Joy's Palette interface to include custom security colors.
 * This provides TypeScript autocomplete and type-safety when using
 * theme.palette.security.* in components.
 */
declare module '@mui/joy/styles' {
  interface Palette {
    security: {
      critical: SecurityColorRange;
      high: SecurityColorRange;
      medium: SecurityColorRange;
      low: SecurityColorRange;
      moderate: SecurityColorRange;
      good: SecurityColorRange;
      excellent: SecurityColorRange;
      neutral: SecurityColorRange;
    };
  }
}

/**
 * Security color palette for light mode
 */
export const securityPaletteLight = {
  security: {
          // Critical severity (red)
          critical: {
            solidBg: '#dc2626', // red-600
            solidColor: '#ffffff',
            plainColor: '#dc2626',
            plainHoverBg: 'rgba(220, 38, 38, 0.08)',
            outlinedBorder: '#dc2626',
            outlinedColor: '#dc2626',
            outlinedHoverBg: 'rgba(220, 38, 38, 0.08)',
            softBg: 'rgba(220, 38, 38, 0.08)',
            softColor: '#dc2626',
            softHoverBg: 'rgba(220, 38, 38, 0.12)',
            // Custom properties for gradients and shadows
            gradientStart: '#dc2626',
            gradientEnd: '#991b1b',
            shadow: 'rgba(220, 38, 38, 0.35)',
          } as SecurityColorRange,
          
          // High severity (orange)
          high: {
            solidBg: '#ea580c', // orange-600
            solidColor: '#ffffff',
            plainColor: '#ea580c',
            plainHoverBg: 'rgba(234, 88, 12, 0.08)',
            outlinedBorder: '#ea580c',
            outlinedColor: '#ea580c',
            outlinedHoverBg: 'rgba(234, 88, 12, 0.08)',
            softBg: 'rgba(234, 88, 12, 0.08)',
            softColor: '#ea580c',
            softHoverBg: 'rgba(234, 88, 12, 0.12)',
            gradientStart: '#ea580c',
            gradientEnd: '#c2410c',
            shadow: 'rgba(234, 88, 12, 0.35)',
          } as SecurityColorRange,
          
          // Medium severity (amber)
          medium: {
            solidBg: '#f59e0b', // amber-500
            solidColor: '#ffffff',
            plainColor: '#f59e0b',
            plainHoverBg: 'rgba(245, 158, 11, 0.08)',
            outlinedBorder: '#f59e0b',
            outlinedColor: '#f59e0b',
            outlinedHoverBg: 'rgba(245, 158, 11, 0.08)',
            softBg: 'rgba(245, 158, 11, 0.08)',
            softColor: '#f59e0b',
            softHoverBg: 'rgba(245, 158, 11, 0.12)',
            gradientStart: '#f59e0b',
            gradientEnd: '#d97706',
            shadow: 'rgba(245, 158, 11, 0.3)',
          } as SecurityColorRange,
          
          // Low severity (yellow)
          low: {
            solidBg: '#eab308', // yellow-500
            solidColor: '#ffffff',
            plainColor: '#eab308',
            plainHoverBg: 'rgba(234, 179, 8, 0.08)',
            outlinedBorder: '#eab308',
            outlinedColor: '#eab308',
            outlinedHoverBg: 'rgba(234, 179, 8, 0.08)',
            softBg: 'rgba(234, 179, 8, 0.08)',
            softColor: '#eab308',
            softHoverBg: 'rgba(234, 179, 8, 0.12)',
            gradientStart: '#eab308',
            gradientEnd: '#ca8a04',
            shadow: 'rgba(234, 179, 8, 0.3)',
          } as SecurityColorRange,
          
          // Moderate score (lime - score-based, not severity)
          moderate: {
            solidBg: '#84cc16', // lime-500 (different from low's yellow-500)
            solidColor: '#ffffff',
            plainColor: '#84cc16',
            plainHoverBg: 'rgba(132, 204, 22, 0.08)',
            outlinedBorder: '#84cc16',
            outlinedColor: '#84cc16',
            outlinedHoverBg: 'rgba(132, 204, 22, 0.08)',
            softBg: 'rgba(132, 204, 22, 0.08)',
            softColor: '#84cc16',
            softHoverBg: 'rgba(132, 204, 22, 0.12)',
            gradientStart: '#84cc16',
            gradientEnd: '#65a30d', // lime-600
            shadow: 'rgba(132, 204, 22, 0.3)',
          } as SecurityColorRange,
          
          // Good score (green)
          good: {
            solidBg: '#22c55e', // green-500
            solidColor: '#ffffff',
            plainColor: '#22c55e',
            plainHoverBg: 'rgba(34, 197, 94, 0.08)',
            outlinedBorder: '#22c55e',
            outlinedColor: '#22c55e',
            outlinedHoverBg: 'rgba(34, 197, 94, 0.08)',
            softBg: 'rgba(34, 197, 94, 0.08)',
            softColor: '#22c55e',
            softHoverBg: 'rgba(34, 197, 94, 0.12)',
            gradientStart: '#22c55e',
            gradientEnd: '#16a34a',
            shadow: 'rgba(34, 197, 94, 0.25)',
          } as SecurityColorRange,
          
          // Excellent score (emerald)
          excellent: {
            solidBg: '#10b981', // emerald-500
            solidColor: '#ffffff',
            plainColor: '#10b981',
            plainHoverBg: 'rgba(16, 185, 129, 0.08)',
            outlinedBorder: '#10b981',
            outlinedColor: '#10b981',
            outlinedHoverBg: 'rgba(16, 185, 129, 0.08)',
            softBg: 'rgba(16, 185, 129, 0.08)',
            softColor: '#10b981',
            softHoverBg: 'rgba(16, 185, 129, 0.12)',
            gradientStart: '#10b981',
            gradientEnd: '#059669',
            shadow: 'rgba(16, 185, 129, 0.25)',
          } as SecurityColorRange,
          
          // Neutral/pending (slate)
          neutral: {
            solidBg: '#64748b', // slate-500
            solidColor: '#ffffff',
            plainColor: '#94a3b8',
            plainHoverBg: 'rgba(148, 163, 184, 0.08)',
            outlinedBorder: '#94a3b8',
            outlinedColor: '#94a3b8',
            outlinedHoverBg: 'rgba(148, 163, 184, 0.08)',
            softBg: 'rgba(148, 163, 184, 0.08)',
            softColor: '#94a3b8',
            softHoverBg: 'rgba(148, 163, 184, 0.12)',
            gradientStart: '#64748b',
            gradientEnd: '#475569',
            shadow: 'rgba(100, 116, 139, 0.2)',
          } as SecurityColorRange,
  },
};

/**
 * Security color palette for dark mode
 */
export const securityPaletteDark = {
  security: {
          // Critical severity (lighter red for dark mode)
          critical: {
            solidBg: '#ef4444', // red-500 (lighter)
            solidColor: '#ffffff',
            plainColor: '#f87171', // red-400
            plainHoverBg: 'rgba(239, 68, 68, 0.15)',
            outlinedBorder: '#ef4444',
            outlinedColor: '#f87171',
            outlinedHoverBg: 'rgba(239, 68, 68, 0.15)',
            softBg: 'rgba(239, 68, 68, 0.15)',
            softColor: '#f87171',
            softHoverBg: 'rgba(239, 68, 68, 0.2)',
            gradientStart: '#ef4444',
            gradientEnd: '#dc2626',
            shadow: 'rgba(239, 68, 68, 0.4)',
          } as SecurityColorRange,
          
          // High severity (lighter orange for dark mode)
          high: {
            solidBg: '#f97316', // orange-500
            solidColor: '#ffffff',
            plainColor: '#fb923c', // orange-400
            plainHoverBg: 'rgba(249, 115, 22, 0.15)',
            outlinedBorder: '#f97316',
            outlinedColor: '#fb923c',
            outlinedHoverBg: 'rgba(249, 115, 22, 0.15)',
            softBg: 'rgba(249, 115, 22, 0.15)',
            softColor: '#fb923c',
            softHoverBg: 'rgba(249, 115, 22, 0.2)',
            gradientStart: '#f97316',
            gradientEnd: '#ea580c',
            shadow: 'rgba(249, 115, 22, 0.4)',
          } as SecurityColorRange,
          
          // Medium severity (lighter amber for dark mode)
          medium: {
            solidBg: '#fbbf24', // amber-400
            solidColor: '#ffffff',
            plainColor: '#fcd34d', // amber-300
            plainHoverBg: 'rgba(251, 191, 36, 0.15)',
            outlinedBorder: '#fbbf24',
            outlinedColor: '#fcd34d',
            outlinedHoverBg: 'rgba(251, 191, 36, 0.15)',
            softBg: 'rgba(251, 191, 36, 0.15)',
            softColor: '#fcd34d',
            softHoverBg: 'rgba(251, 191, 36, 0.2)',
            gradientStart: '#fbbf24',
            gradientEnd: '#f59e0b',
            shadow: 'rgba(251, 191, 36, 0.35)',
          } as SecurityColorRange,
          
          // Low severity (lighter yellow for dark mode)
          low: {
            solidBg: '#facc15', // yellow-400
            solidColor: '#1e293b', // slate-800 (dark text)
            plainColor: '#fde047', // yellow-300
            plainHoverBg: 'rgba(250, 204, 21, 0.15)',
            outlinedBorder: '#facc15',
            outlinedColor: '#fde047',
            outlinedHoverBg: 'rgba(250, 204, 21, 0.15)',
            softBg: 'rgba(250, 204, 21, 0.15)',
            softColor: '#fde047',
            softHoverBg: 'rgba(250, 204, 21, 0.2)',
            gradientStart: '#facc15',
            gradientEnd: '#eab308',
            shadow: 'rgba(250, 204, 21, 0.35)',
          } as SecurityColorRange,
          
          // Moderate score (lighter lime for dark mode - different from low)
          moderate: {
            solidBg: '#a3e635', // lime-400 (different from low's yellow-400)
            solidColor: '#1e293b', // slate-800 (dark text)
            plainColor: '#bef264', // lime-300
            plainHoverBg: 'rgba(163, 230, 53, 0.15)',
            outlinedBorder: '#a3e635',
            outlinedColor: '#bef264',
            outlinedHoverBg: 'rgba(163, 230, 53, 0.15)',
            softBg: 'rgba(163, 230, 53, 0.15)',
            softColor: '#bef264',
            softHoverBg: 'rgba(163, 230, 53, 0.2)',
            gradientStart: '#a3e635',
            gradientEnd: '#84cc16', // lime-500
            shadow: 'rgba(163, 230, 53, 0.35)',
          } as SecurityColorRange,
          
          // Good score (lighter green for dark mode)
          good: {
            solidBg: '#4ade80', // green-400
            solidColor: '#ffffff',
            plainColor: '#86efac', // green-300
            plainHoverBg: 'rgba(74, 222, 128, 0.15)',
            outlinedBorder: '#4ade80',
            outlinedColor: '#86efac',
            outlinedHoverBg: 'rgba(74, 222, 128, 0.15)',
            softBg: 'rgba(74, 222, 128, 0.15)',
            softColor: '#86efac',
            softHoverBg: 'rgba(74, 222, 128, 0.2)',
            gradientStart: '#4ade80',
            gradientEnd: '#22c55e',
            shadow: 'rgba(74, 222, 128, 0.3)',
          } as SecurityColorRange,
          
          // Excellent score (lighter emerald for dark mode)
          excellent: {
            solidBg: '#34d399', // emerald-400
            solidColor: '#ffffff',
            plainColor: '#6ee7b7', // emerald-300
            plainHoverBg: 'rgba(52, 211, 153, 0.15)',
            outlinedBorder: '#34d399',
            outlinedColor: '#6ee7b7',
            outlinedHoverBg: 'rgba(52, 211, 153, 0.15)',
            softBg: 'rgba(52, 211, 153, 0.15)',
            softColor: '#6ee7b7',
            softHoverBg: 'rgba(52, 211, 153, 0.2)',
            gradientStart: '#34d399',
            gradientEnd: '#10b981',
            shadow: 'rgba(52, 211, 153, 0.3)',
          } as SecurityColorRange,
          
          // Neutral/pending (lighter slate for dark mode)
          neutral: {
            solidBg: '#94a3b8', // slate-400
            solidColor: '#ffffff',
            plainColor: '#cbd5e1', // slate-300
            plainHoverBg: 'rgba(148, 163, 184, 0.15)',
            outlinedBorder: '#94a3b8',
            outlinedColor: '#cbd5e1',
            outlinedHoverBg: 'rgba(148, 163, 184, 0.15)',
            softBg: 'rgba(148, 163, 184, 0.15)',
            softColor: '#cbd5e1',
            softHoverBg: 'rgba(148, 163, 184, 0.2)',
            gradientStart: '#94a3b8',
            gradientEnd: '#64748b',
            shadow: 'rgba(148, 163, 184, 0.25)',
          } as SecurityColorRange,
  },
};
