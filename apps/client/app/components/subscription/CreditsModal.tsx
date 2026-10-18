import BillingModal from './BillingModal';

interface CreditsModalProps {
  open: boolean;
  onClose: () => void;
}

/** Billing modal opened at the credit packs, for "buy credits" entry points outside the app shell's `?billing=`. */
const CreditsModal = ({ open, onClose }: CreditsModalProps) => (
  <BillingModal open={open} focus="credits" onClose={onClose} />
);

export default CreditsModal;
