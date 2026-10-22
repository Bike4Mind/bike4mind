import { IBaseEvent } from '../../../types';

/**
 * One-off credit purchase funnel, in order. Every step after CHECKOUT_REQUESTED carries the
 * Stripe payment intent id so a support claim can be traced from the button to the ledger row.
 * Metadata is deliberately PII-free: no email, card data or client secret.
 */
export enum CreditPurchaseEvents {
  /** Client: Purchase pressed, start-payment requested. */
  CHECKOUT_REQUESTED = 'Credit Checkout Requested',
  /** Client: start-payment failed, so no payment form was shown. */
  CHECKOUT_START_FAILED = 'Credit Checkout Start Failed',
  /** Server: payment intent created. The durable "checkout started" marker. */
  CHECKOUT_STARTED = 'Credit Checkout Started',
  /** Client: Stripe payment form shown. */
  PAYMENT_FORM_OPENED = 'Credit Payment Form Opened',
  /** Client: result of stripe.confirmPayment. */
  PAYMENT_CONFIRM_RESULT = 'Credit Payment Confirm Result',
  /** Client: payment form closed before a successful or processing confirm. */
  PAYMENT_ABANDONED = 'Credit Payment Abandoned',
  /** Server: webhook granted the purchased credits. */
  CREDITS_GRANTED = 'Credit Purchase Granted',
  /** Server: a webhook redelivery found the credits already granted. Not a second grant. */
  CREDITS_ALREADY_GRANTED = 'Credit Purchase Already Granted',
}

export type CreditPurchaseConfirmOutcome = 'succeeded' | 'processing' | 'requires_action' | 'error' | 'unknown';

interface ICheckoutRequestedEvent extends IBaseEvent {
  type: CreditPurchaseEvents.CHECKOUT_REQUESTED;
  metadata: {
    transactionType: string;
    packageId?: string;
    credits?: number;
  };
}

interface ICheckoutStartFailedEvent extends IBaseEvent {
  type: CreditPurchaseEvents.CHECKOUT_START_FAILED;
  metadata: {
    transactionType: string;
    /** HTTP status of the failed start-payment call; absent for a network failure. */
    httpStatus?: number;
  };
}

interface ICheckoutStartedEvent extends IBaseEvent {
  type: CreditPurchaseEvents.CHECKOUT_STARTED;
  metadata: {
    paymentIntentId: string;
    transactionType: string;
    /** Minor units (cents). */
    amount: number;
    credits: number;
    packageId?: string;
  };
}

interface IPaymentFormOpenedEvent extends IBaseEvent {
  type: CreditPurchaseEvents.PAYMENT_FORM_OPENED;
  metadata: {
    paymentIntentId: string;
  };
}

interface IPaymentConfirmResultEvent extends IBaseEvent {
  type: CreditPurchaseEvents.PAYMENT_CONFIRM_RESULT;
  metadata: {
    paymentIntentId: string;
    outcome: CreditPurchaseConfirmOutcome;
    /** Stripe error type/code/decline_code; never the human-readable message. */
    errorType?: string;
    errorCode?: string;
    declineCode?: string;
  };
}

interface IPaymentAbandonedEvent extends IBaseEvent {
  type: CreditPurchaseEvents.PAYMENT_ABANDONED;
  metadata: {
    paymentIntentId: string;
    /** Last confirm outcome before closing, if the user tried to pay at all. */
    lastOutcome?: CreditPurchaseConfirmOutcome;
  };
}

interface ICreditsGrantedEvent extends IBaseEvent {
  type: CreditPurchaseEvents.CREDITS_GRANTED;
  metadata: {
    paymentIntentId: string;
    /** Minor units (cents). */
    amount: number;
    credits: number;
    packageId?: string;
  };
}

interface ICreditsAlreadyGrantedEvent extends IBaseEvent {
  type: CreditPurchaseEvents.CREDITS_ALREADY_GRANTED;
  metadata: {
    paymentIntentId: string;
    /** Minor units (cents). */
    amount: number;
    credits: number;
  };
}

export type CreditPurchaseEventPayload =
  | ICheckoutRequestedEvent
  | ICheckoutStartFailedEvent
  | ICheckoutStartedEvent
  | IPaymentFormOpenedEvent
  | IPaymentConfirmResultEvent
  | IPaymentAbandonedEvent
  | ICreditsGrantedEvent
  | ICreditsAlreadyGrantedEvent;
