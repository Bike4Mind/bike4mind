import type { ReactNode } from 'react';
import { CircularProgress } from '@mui/joy';
import { styled } from '@mui/system';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import { STUDIO_FOCUS_VISIBLE, studioColor, studioFont, studioRadius } from './studioTokens';

const ActionRoot = styled('button')({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '10px',
  height: '48px',
  padding: '0 22px',
  borderRadius: studioRadius('sm'),
  border: `1px solid ${studioColor('accent')}`,
  backgroundColor: studioColor('accent'),
  color: studioColor('accent-contrast'),
  font: `600 14px/1 ${studioFont('ui')}`,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  transition: 'background-color 120ms ease, transform 80ms ease',
  '&:hover:not(:disabled)': { backgroundColor: studioColor('accent-hover'), borderColor: studioColor('accent-hover') },
  '&:active:not(:disabled)': { transform: 'translateY(1px)' },
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
  '&:disabled': { opacity: 0.45, cursor: 'not-allowed' },
  '&[data-size="md"]': { height: '36px', padding: '0 14px', fontSize: '13px' },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none', '&:active:not(:disabled)': { transform: 'none' } },
});

const Cost = styled('span')({
  fontFamily: studioFont('mono'),
  fontWeight: 400,
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.85,
});

type StudioPrimaryActionProps = {
  children: ReactNode;
  /** Credits the action will spend, shown after the label in mono ("Make 4  48 cr"). */
  cost?: number;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'lg';
  type?: 'button' | 'submit';
  onClick?: () => void;
  testId?: string;
};

/** The one filled accent button on a Studio screen; its price rides inside it so the cost is never a surprise. */
const StudioPrimaryAction = ({
  children,
  cost,
  loading = false,
  disabled = false,
  size = 'lg',
  type = 'button',
  onClick,
  testId = 'studio-primary-action',
}: StudioPrimaryActionProps) => (
  <ActionRoot
    type={type}
    data-size={size}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    onClick={onClick}
    data-testid={testId}
  >
    {loading && (
      <CircularProgress size="sm" variant="plain" sx={{ '--CircularProgress-progressColor': 'currentColor' }} />
    )}
    {children}
    {cost !== undefined && (
      <Cost data-testid={`${testId}-cost`}>{formatCreditAmount(Math.max(0, Math.ceil(cost)))} cr</Cost>
    )}
  </ActionRoot>
);

export default StudioPrimaryAction;
