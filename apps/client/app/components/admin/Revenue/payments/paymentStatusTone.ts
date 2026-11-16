import type { PaymentKind, PaymentStatus } from '@bike4mind/server-utils/app/utils/adminPayments';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

export const PAYMENT_STATUS_DISPLAY: Record<PaymentStatus, { label: string; tone: AdminStatusTone }> = {
  succeeded: { label: 'Succeeded', tone: 'good' },
  pending: { label: 'Pending', tone: 'info' },
  failed: { label: 'Failed', tone: 'bad' },
  refunded: { label: 'Refunded', tone: 'warn' },
  partially_refunded: { label: 'Partially refunded', tone: 'warn' },
  disputed: { label: 'Disputed', tone: 'warn' },
  dispute_lost: { label: 'Dispute lost', tone: 'bad' },
};

export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  subscription: 'Subscription',
  credit_purchase: 'Credit purchase',
};
