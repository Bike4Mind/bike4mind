import { Box, Button, Tooltip, Typography } from '@mui/joy';
import InfoRoundedIcon from '@mui/icons-material/InfoRounded';
import type { ISessionDocument } from '@bike4mind/common';
import { useCreditPayerNote } from './CreditPayerNote';
import { STATUS_ITEM_HEIGHT, useStatusLineCompact } from './SessionBottom/ComposerStatusLine';
import { FC, useState } from 'react';
import CreditIcon from '../svgs/icons/CreditIcon';
import { orange } from '@client/app/utils/themes/colors';
import BillingModal from '../subscription/BillingModal';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { formatCreditBalance } from '@client/app/utils/formatCredits';
import { FirstRunEvents, LOW_CREDITS_THRESHOLD_DEFAULT } from '@bike4mind/common';
import { useLowCreditsThreshold } from '@client/app/hooks/data/teamPlanSettings';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { estimateAnswerCount, typicalAnswerCredits } from '@client/app/utils/creditEstimate';
import { useLogEvent } from '@client/app/hooks/data/analytics';

/**
 * Default threshold below which credits are considered "low". The live value is the
 * `lowCreditsThreshold` admin setting - read it with `useLowCreditsThreshold()`.
 */
export const LOW_CREDITS_THRESHOLD = LOW_CREDITS_THRESHOLD_DEFAULT;

function balanceTooltip(credits: number, lowCreditsThreshold: number): string {
  if (credits <= 0) return 'No credits left. Subscribe or top up to continue. Your chats and files are safe.';
  if (credits < lowCreditsThreshold) return 'Running low. Subscribe or top up so your work is not interrupted.';
  return 'About how many typical answers are left on the current model. Click to see plans and top up.';
}

/**
 * The balance as quiet text, coloured only when it runs low; no data of its own, so a preview can
 * render any balance. CreditBalanceChip feeds it the live one.
 */
export const CreditBalanceChipView: FC<{
  credits: number;
  lowCreditsThreshold: number;
  onClick: () => void;
  answersLeft?: number | null;
  modelName?: string;
  /** Who pays, in a notebook the user does not own (useCreditPayerNote): an info mark and the tooltip's first line. */
  payerNote?: string | null;
}> = ({ credits, lowCreditsThreshold, onClick, answersLeft, modelName, payerNote }) => {
  const color = credits <= 0 ? 'danger' : credits < lowCreditsThreshold ? 'warning' : 'neutral';
  const balanceText = balanceTooltip(credits, lowCreditsThreshold);
  // Out of room on the status line: the number without "credits" (the icon says it; the name keeps it).
  const compact = useStatusLineCompact();
  const hasEstimate = answersLeft !== undefined && answersLeft !== null;
  const count = hasEstimate ? (credits <= 0 ? 0 : answersLeft) : null;
  const noun = count === 1 ? 'answer' : 'answers';
  const shown =
    count === null
      ? formatCreditBalance(credits)
      : count < 1
        ? credits <= 0
          ? compact
            ? '0'
            : '0 answers'
          : compact
            ? '<1'
            : '<1 answer'
        : `~${count.toLocaleString('en-US')}${compact ? '' : ` ${noun}`}`;
  const answerPhrase =
    count === null
      ? null
      : count < 1
        ? credits <= 0
          ? '0 answers'
          : 'less than 1 typical answer'
        : `about ${count.toLocaleString('en-US')} typical ${noun}`;
  const ariaLabel =
    credits <= 0
      ? `No credits left.${payerNote ? ` ${payerNote}.` : ''} See plans and top up`
      : `${answerPhrase ?? formatCreditBalance(credits)} left${modelName ? ` on ${modelName}` : ''}.` +
        `${answerPhrase ? ` ${formatCreditBalance(credits)}.` : ''}${payerNote ? ` ${payerNote}.` : ''} See plans and top up`;
  const title = payerNote ? (
    <Box sx={{ maxWidth: 280, display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <Typography level="body-xs" textColor="inherit" sx={{ fontWeight: 600 }}>
        {payerNote}
      </Typography>
      <Typography level="body-xs" textColor="inherit">
        {balanceText}
      </Typography>
    </Box>
  ) : (
    balanceText
  );
  return (
    <Tooltip title={title} placement="top" variant="soft">
      <Button
        size="sm"
        variant="plain"
        color={color}
        onClick={onClick}
        data-testid="credit-balance-chip"
        aria-label={ariaLabel}
        startDecorator={<CreditIcon sx={{ fontSize: 14 }} />}
        endDecorator={
          payerNote ? (
            <InfoRoundedIcon data-testid="credit-payer-mark" sx={{ fontSize: 14, color: 'inherit' }} />
          ) : undefined
        }
        sx={{
          height: STATUS_ITEM_HEIGHT,
          minHeight: STATUS_ITEM_HEIGHT,
          px: 0.75,
          gap: 0.25,
          borderRadius: '6px',
          whiteSpace: 'nowrap',
          fontSize: '12px',
          fontWeight: 400,
          fontVariantNumeric: 'tabular-nums',
          ...(color === 'neutral' && {
            '--variant-plainColor': 'var(--joy-palette-text-tertiary)',
            '--variant-plainHoverColor': 'var(--joy-palette-text-secondary)',
          }),
          // Low: the same orange and neutral hover as Research Mode's no-models state
          // (ResearchModeIndicator), not the paler warning.plainColor.
          ...(color === 'warning' && {
            '--variant-plainColor': orange[450],
            '--variant-plainHoverColor': orange[450],
            '--variant-plainHoverBg': 'var(--joy-palette-neutral-plainHoverBg)',
            '--variant-plainActiveBg': 'var(--joy-palette-neutral-plainActiveBg)',
          }),
        }}
      >
        {shown}
      </Button>
    </Tooltip>
  );
};

/**
 * Labeled credit balance for the status line above the composer (ComposerStatusLine); opens the
 * credits modal (packages + transaction history). Quiet text at rest, coloured only when the
 * balance runs low. Renders nothing while `enforceCredits` is off, matching the profile menu -
 * nothing decrements then, so a balance would mislead. Uses the display (not live) balance so it
 * holds steady through a turn's reservation dip (see useEffectiveCredits).
 */
const CreditBalanceChip: FC<{ session?: ISessionDocument | null }> = ({ session }) => {
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const payerNote = useCreditPayerNote(session);
  const credits = useEffectiveCredits();
  const lowCreditsThreshold = useLowCreditsThreshold();
  const model = useLLM(state => state.model);
  const { data: models } = useModelInfo();
  const selected = models?.find(candidate => candidate.id === model);
  const answerCost = selected ? typicalAnswerCredits(selected) : null;
  const answersLeft = answerCost ? estimateAnswerCount(credits, answerCost) : null;
  const [isOpen, setIsOpen] = useState(false);
  const { mutate: logEvent } = useLogEvent();

  if (!enforceCredits) return null;

  return (
    <>
      <CreditBalanceChipView
        credits={credits}
        lowCreditsThreshold={lowCreditsThreshold}
        onClick={() => {
          logEvent({ type: FirstRunEvents.CREDITS_CHIP_CLICKED });
          setIsOpen(true);
        }}
        answersLeft={answersLeft}
        modelName={selected?.name}
        payerNote={payerNote}
      />
      <BillingModal open={isOpen} entry="credits_chip" onClose={() => setIsOpen(false)} />
    </>
  );
};

export default CreditBalanceChip;
