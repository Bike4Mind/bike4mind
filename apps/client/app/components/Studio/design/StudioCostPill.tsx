import { styled } from '@mui/system';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import { studioColor, studioFont, studioRadius } from './studioTokens';

const PillRoot = styled('span')({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontFamily: studioFont('mono'),
  fontSize: '12px',
  fontWeight: 400,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  color: studioColor('text-secondary'),
  '&[data-variant="pill"]': {
    height: '28px',
    padding: '0 10px',
    borderRadius: studioRadius('pill'),
    border: `1px solid ${studioColor('border')}`,
    backgroundColor: studioColor('raised'),
  },
  '&[data-tone="low"]': { color: studioColor('warning') },
  '&[data-tone="low"][data-variant="pill"]': {
    borderColor: studioColor('warning-border'),
    backgroundColor: studioColor('warning-soft'),
  },
  '&[data-tone="empty"]': { color: studioColor('danger') },
  '&[data-tone="empty"][data-variant="pill"]': {
    borderColor: studioColor('danger-border'),
    backgroundColor: studioColor('danger-soft'),
  },
});

const Dot = styled('span')({
  width: '6px',
  height: '6px',
  borderRadius: studioRadius('pill'),
  backgroundColor: 'currentColor',
});

type StudioCostPillProps = {
  /** Whole credits; fractions round down and negatives show 0, as everywhere else a balance appears. */
  amount: number;
  /** `cr` for a price beside an action, `credits` for a balance. */
  unit?: 'cr' | 'credits';
  /** `text` is bare mono text (header balance, inline cost); `pill` adds the hairline capsule. */
  variant?: 'text' | 'pill';
  /** `low` is warm with a dot; `empty` (nothing left to spend) is danger with a dot. */
  tone?: 'default' | 'low' | 'empty';
  testId?: string;
};

/** A credit figure in mono with tabular digits, so prices and balances line up and never jitter. */
const StudioCostPill = ({
  amount,
  unit = 'cr',
  variant = 'text',
  tone = 'default',
  testId = 'studio-cost-pill',
}: StudioCostPillProps) => {
  const whole = Math.max(0, Math.floor(amount));
  return (
    <PillRoot data-variant={variant} data-tone={tone} data-testid={testId}>
      {tone !== 'default' && <Dot aria-hidden="true" />}
      {formatCreditAmount(whole)} {unit === 'credits' && whole === 1 ? 'credit' : unit}
    </PillRoot>
  );
};

export default StudioCostPill;
