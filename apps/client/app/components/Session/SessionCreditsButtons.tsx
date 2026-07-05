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

export const SessionCreditsButton = () => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="session-credits-btn">
        Add Credits
      </Button>
      <CreditsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};
