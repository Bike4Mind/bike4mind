import type { ReactNode } from 'react';
import { styled } from '@mui/system';
import { STUDIO_FOCUS_VISIBLE, studioColor, studioFont, studioRadius } from './studioTokens';

const ChipRoot = styled('button')({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  height: '32px',
  padding: '0 12px',
  borderRadius: studioRadius('pill'),
  border: `1px solid ${studioColor('border')}`,
  backgroundColor: 'transparent',
  color: studioColor('text-secondary'),
  font: `500 12px/1 ${studioFont('ui')}`,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
  '&:hover:not(:disabled)': { backgroundColor: studioColor('hover'), color: studioColor('text') },
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
  '&[aria-pressed="true"]': {
    backgroundColor: studioColor('accent-soft'),
    borderColor: studioColor('accent-border'),
    color: studioColor('accent-on-soft'),
  },
  '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

const Swatch = styled('span')({
  width: '14px',
  height: '14px',
  flexShrink: 0,
  borderRadius: studioRadius('pill'),
  boxShadow: `inset 0 0 0 1px ${studioColor('border-strong')}`,
});

type StudioChipProps = {
  children: ReactNode;
  /** Makes the chip a toggle (`aria-pressed`); leave it out for a one-shot action chip, such as a snippet. */
  selected?: boolean;
  /** Any CSS color or gradient; shows as a small round swatch before the label (scene chips). */
  swatch?: string;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
};

/** A round chip: a toggle when given `selected` (exposed as `aria-pressed`, drawn in the accent), else an action. */
const StudioChip = ({ children, selected, swatch, disabled, onClick, testId = 'studio-chip' }: StudioChipProps) => (
  <ChipRoot type="button" aria-pressed={selected} disabled={disabled} onClick={onClick} data-testid={testId}>
    {swatch && <Swatch aria-hidden="true" style={{ background: swatch }} data-testid={`${testId}-swatch`} />}
    {children}
  </ChipRoot>
);

export default StudioChip;
