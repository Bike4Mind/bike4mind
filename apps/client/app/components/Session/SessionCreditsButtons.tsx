import { useState } from 'react';
import Button from '@mui/joy/Button';
import CreditsModal from '../subscription/CreditsModal';
import SubscriptionModal from '../subscription/SubscriptionModal';

export const SubscribeButton = () => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="session-subscribe-btn">
        Subscribe
      </Button>
      <SubscriptionModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};

/** `secondary` renders it outlined and neutral, for when it sits beside Subscribe as the lesser option. */
export const SessionCreditsButton = ({ secondary = false }: { secondary?: boolean }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        data-testid="session-credits-btn"
        {...(secondary && { variant: 'outlined', color: 'neutral' })}
      >
        Add Credits
      </Button>
      <CreditsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};
