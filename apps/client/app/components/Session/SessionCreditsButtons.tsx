import { useState } from 'react';
import Button from '@mui/joy/Button';
import CreditsModal from '../subscription/CreditsModal';
import SubscriptionModal from '../subscription/SubscriptionModal';

/** `label` lets an offer name the plan it sells instead of the generic verb. */
export const SubscribeButton = ({ label = 'Subscribe' }: { label?: string }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* 6px corners, like the outlined credits button it usually sits beside (SessionCreditsButton). */}
      <Button onClick={() => setOpen(true)} data-testid="session-subscribe-btn" sx={{ borderRadius: '6px' }}>
        {label}
      </Button>
      <SubscriptionModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};

/**
 * The lesser credit action: outlined and neutral. An outlined button is see-through, and these sit on
 * tinted notes (ComposerNote), so it gets the page surface; hover goes through Joy's variant vars (a
 * plain &:hover loses to its own rule), and its default hover fill is translucent too, so opaque levels.
 */
export const SECONDARY_CREDIT_BUTTON_PROPS = {
  variant: 'outlined',
  color: 'neutral',
  sx: {
    borderRadius: '6px',
    backgroundColor: 'background.surface',
    '--variant-outlinedHoverBg': 'var(--joy-palette-background-level1)',
    '--variant-outlinedActiveBg': 'var(--joy-palette-background-level2)',
  },
} as const;

/** `secondary` renders it outlined and neutral, for when it sits beside Subscribe as the lesser option. */
export const SessionCreditsButton = ({
  secondary = false,
  label = 'Add Credits',
}: {
  secondary?: boolean;
  label?: string;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        data-testid="session-credits-btn"
        {...(secondary && SECONDARY_CREDIT_BUTTON_PROPS)}
      >
        {label}
      </Button>
      <CreditsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};
