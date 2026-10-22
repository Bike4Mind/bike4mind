import BillingModal from './BillingModal';

interface SubscriptionModalProps {
  open: boolean;
  onClose: () => void;
}

/** Billing modal opened at the plans, for "upgrade" entry points outside the app shell's `?billing=`. */
const SubscriptionModal = ({ open, onClose }: SubscriptionModalProps) => (
  <BillingModal open={open} focus="plans" onClose={onClose} />
);

export default SubscriptionModal;
