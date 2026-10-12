import { useState } from 'react';
import Button from '@mui/joy/Button';
import CreditsModal from '../subscription/CreditsModal';
import SubscriptionModal from '../subscription/SubscriptionModal';

/** `label` lets an offer name the plan it sells instead of the generic verb. */
export const SubscribeButton = ({ label = 'Subscribe' }: { label?: string }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="session-subscribe-btn">
        {label}
      </Button>
      <SubscriptionModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};

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
        {...(secondary && { variant: 'outlined', color: 'neutral' })}
      >
        {label}
      </Button>
      <CreditsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};
