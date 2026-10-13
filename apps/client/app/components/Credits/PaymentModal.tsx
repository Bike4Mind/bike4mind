import { Modal, ModalDialog, Typography } from '@mui/joy';
import { Elements } from '@stripe/react-stripe-js';
import CheckoutForm, { ConfirmResult } from './CheckoutForm';
import { Stripe } from '@stripe/stripe-js';

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  stripePromise: Promise<Stripe | null>;
  clientSecret: string;
  onPayment: () => void;
  onConfirmResult?: (result: ConfirmResult) => void;
  productName: string;
}

const PaymentModal = ({
  isOpen,
  onClose,
  stripePromise,
  clientSecret,
  productName,
  onPayment,
  onConfirmResult,
}: PaymentModalProps) => {
  return (
    <Modal open={isOpen} onClose={onClose}>
      <ModalDialog
        sx={{
          minWidth: '400px',
          maxWidth: '600px',
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
          zIndex: 1400, // Higher than the parent modal
        }}
      >
        <Typography level="h4" component="h2" sx={{ mb: 2 }}>
          Purchase {productName}
        </Typography>
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <CheckoutForm clientSecret={clientSecret} onPayment={onPayment} onConfirmResult={onConfirmResult} />
        </Elements>
      </ModalDialog>
    </Modal>
  );
};

export default PaymentModal;
