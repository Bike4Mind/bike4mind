import { FC } from 'react';
import { Box, Tooltip, Typography } from '@mui/joy';
import { formatTokenCount, type SessionContextUsage } from '@client/app/hooks/useSessionContextUsage';
import { orange } from '@client/app/utils/themes/colors';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import type { AttachmentFitWarning } from '@client/app/hooks/useAttachmentFitWarning';
import { STATUS_ITEM_HEIGHT } from './ComposerStatusLine';

interface ContextUsageChipProps {
  /** The last completed turn's assembled context; null before the first turn. */
  usage: SessionContextUsage | null;
  modelName: string;
  /** Before any turn: the message being written alone is over the model's input budget. */
  inputOverLimit?: boolean;
  /** A file on this turn that will be cut to fit; turns the chip red and explains it. */
  attachment?: AttachmentFitWarning | null;
}

const RING_R = 5;
const RING_C = 2 * Math.PI * RING_R;

/** A 14px ring filled to `pct`, in the text colour. */
const Ring: FC<{ pct: number }> = ({ pct }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden style={{ flexShrink: 0, transform: 'rotate(-90deg)' }}>
    <circle cx="7" cy="7" r={RING_R} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth="2" />
    <circle
      cx="7"
      cy="7"
      r={RING_R}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeDasharray={RING_C}
      strokeDashoffset={RING_C * (1 - Math.min(Math.max(pct, 0), 100) / 100)}
    />
  </svg>
);

const COLORS = {
  normal: 'var(--joy-palette-text-tertiary)',
  // Same orange as the low balance and Research Mode (CreditBalanceChipView, ResearchModeIndicator).
  warning: orange[450],
  danger: 'var(--joy-palette-danger-plainColor)',
};

/**
 * How full the notebook's context is, on the composer's status line next to the balance
 * (ComposerStatusLine): a ring and a percentage, grey until it nears the limit, then orange, then
 * red. The details - tokens, what happens as it fills, caching, compaction and a file on this turn
 * that will be cut to fit (which turns it red) - are in the tooltip. Replaces the context banners
 * above the composer and the corner readout.
 */
const ContextUsageChip: FC<ContextUsageChipProps> = ({ usage, modelName, inputOverLimit = false, attachment }) => {
  if (!usage && !inputOverLimit && !attachment) return null;

  const pct = usage ? Math.round(usage.utilizationPercentage) : 100;
  const band = !usage || usage.overflowDetected || attachment ? 'danger' : usage.band;

  const lines: string[] = [];
  let attachmentNotice: string | null = null;
  if (attachment) {
    // Hedged when the figure came from byte size, since that only tracks text length for plain text.
    const about = attachment.measured === 'extracted' ? 'about' : 'roughly';
    // Naming the sibling count matters: the budget is divided across attachments, so the fix is often
    // "send fewer files" rather than "pick another model".
    const because =
      attachment.siblingCount > 0
        ? `Its budget is shared with ${attachment.siblingCount} other attachment${attachment.siblingCount > 1 ? 's' : ''}, so sending fewer files at once will help.`
        : 'Switch to a model with a larger context window, or split the file.';
    attachmentNotice = `"${attachment.fileName}" is too large for ${modelName} - ${about} ${attachment.deliveredPercent}% of it will reach the model.`;
    lines.push(attachmentNotice, `The rest is cut before sending. ${because}`);
  }
  if (!usage) {
    if (inputOverLimit) lines.push(`This message is longer than ${modelName} can take in one turn.`);
  } else {
    const headline = usage.overflowDetected
      ? `Context is full for ${modelName}`
      : band === 'danger'
        ? `Context nearly full for ${modelName}`
        : band === 'warning'
          ? `Context is filling up on ${modelName}`
          : `Context used on ${modelName}`;
    lines.push(
      `${headline}: ${formatTokenCount(usage.actualInputTokens)} of ${formatTokenCount(usage.safeMaxInputTokens)} tokens (${pct}%)`
    );
    if (usage.overflowDetected) {
      lines.push(
        'The next turn may be rejected. Start a new notebook to reset, or the oldest turns will be dropped from context.'
      );
    } else if (band !== 'normal') {
      lines.push(
        'As it fills, older turns get summarized or dropped and answers can lose detail. Consider starting a new notebook for a fresh topic.'
      );
    }
    if (usage.compactedTurns > 0) {
      lines.push(
        `Condensed ${usage.compactedTurns} earlier ${usage.compactedTurns === 1 ? 'turn' : 'turns'} into working memory to keep this conversation going.`
      );
    }
    if (usage.cachingIneffective) {
      lines.push('This model applies no caching discount, so each turn re-bills the full context.');
    }
  }

  const label = usage ? `${pct}%` : 'Too long';
  const ariaLabel = usage ? `Context ${label} used` : `Context: ${label}`;

  return (
    <Tooltip
      placement="top"
      variant="soft"
      title={
        <Box sx={{ maxWidth: 300, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {lines.map(line => (
            <Typography key={line} level="body-xs" textColor="inherit">
              {line}
            </Typography>
          ))}
        </Box>
      }
    >
      {/* Quiet text like the balance beside it (CreditBalanceChipView); not a button, it opens nothing. */}
      <Box
        tabIndex={0}
        aria-label={ariaLabel}
        data-testid="context-usage-chip"
        data-band={band}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          height: STATUS_ITEM_HEIGHT,
          px: 0.75,
          borderRadius: '6px',
          fontSize: '12px',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          color: COLORS[band],
          cursor: 'default',
          '&:hover, &:focus-visible': { backgroundColor: 'var(--joy-palette-neutral-plainHoverBg)' },
        }}
      >
        <Ring pct={pct} />
        {label}
        {/* Spoken without hovering: the file warning has to reach the user before they send. 'polite'
            so it waits for a pause instead of interrupting mid-compose. */}
        <Box component="span" role="status" aria-live="polite" sx={visuallyHidden}>
          {attachmentNotice}
        </Box>
      </Box>
    </Tooltip>
  );
};

export default ContextUsageChip;
