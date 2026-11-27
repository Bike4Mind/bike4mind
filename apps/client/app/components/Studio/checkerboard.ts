/** The usual transparency checkerboard, so a cutout's transparent pixels read as transparent rather than white. */
export const CHECKERBOARD_SX = {
  backgroundColor: 'var(--joy-palette-neutral-50)',
  backgroundImage:
    'conic-gradient(var(--joy-palette-neutral-200) 25%, transparent 0 50%, var(--joy-palette-neutral-200) 0 75%, transparent 0)',
  backgroundSize: '12px 12px',
} as const;
