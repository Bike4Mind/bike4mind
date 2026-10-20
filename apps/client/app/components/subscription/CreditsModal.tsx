import BillingModal from './BillingModal';

interface CreditsModalProps {
  open: boolean;
  onClose: () => void;
  entry?: string;
}

/** Billing modal opened at the credit packs, for "buy credits" entry points outside the app shell's `?billing=`. */
const CreditsModal = ({ open, onClose, entry = 'credits_cta' }: CreditsModalProps) => (
  <BillingModal open={open} focus="credits" entry={entry} onClose={onClose} />
);

export default CreditsModal;
