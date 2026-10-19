import { buildEmailLogoImg, escapeHtml } from './emailHelpers';

export interface PaymentFailedEmailInput {
  /** Where the owner updates the card: the org Billing tab, or the personal plans modal. */
  billingUrl: string;
  /** Stripe's card-error message, which Stripe documents as safe to show the customer. */
  failureReason?: string | null;
  /** When Stripe will retry; absent when no retry is scheduled. */
  nextAttemptAt?: Date | null;
  /** Set for an org subscription, so the copy names which plan failed. */
  organizationName?: string | null;
}

export interface CanceledForNonPaymentEmailInput {
  billingUrl: string;
  organizationName?: string | null;
}

export interface EmailContent {
  subject: string;
  body: string;
}

const formatDate = (date: Date): string =>
  date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** "the Acme subscription" / "your Brand subscription", unescaped; escape it for HTML. */
const planNoun = (brand: string, organizationName?: string | null): string =>
  organizationName ? `the ${organizationName} subscription` : `your ${brand ? `${brand} ` : ''}subscription`;

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// A subject is plain text, not HTML; line breaks are dropped so an org name cannot spill into
// further header lines (same rule as inviteNotificationEmail.ts).
const toSubject = (text: string): string => text.replace(/[\r\n]+/g, ' ');

const layout = (brand: string, heading: string, content: string): string => `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            border-bottom: 3px solid #1976d2;
            padding-bottom: 20px;
            margin-bottom: 30px;
          }
          .logo {
            max-height: 40px;
            margin-bottom: 12px;
          }
          h1 {
            color: #1976d2;
            font-size: 24px;
            margin: 0;
          }
          .reason {
            background-color: #f5f5f5;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #d32f2f;
            margin: 20px 0;
          }
          .cta-button {
            display: inline-block;
            background-color: #1976d2;
            color: white !important;
            padding: 12px 24px;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            margin: 20px 0;
          }
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666666;
          }
        </style>
      </head>
      <body>
        <div class="header">
          ${buildEmailLogoImg(brand)}
          <h1>${heading}</h1>
        </div>
        <div class="content">
          ${content}
        </div>
        <div class="footer">
          <p>You are receiving this because you own this subscription${brand ? ` on ${escapeHtml(brand)}` : ''}.</p>
        </div>
      </body>
    </html>
  `;

/**
 * The first-failure notice for a subscription renewal. Access is paused from this point, not at
 * cancellation: `past_due` grants no entitlements (server/entitlements/index.ts), so the copy
 * must not promise otherwise.
 */
export const buildPaymentFailedEmail = (input: PaymentFailedEmailInput): EmailContent => {
  const brand = process.env.APP_NAME || '';
  const plan = escapeHtml(planNoun(brand, input.organizationName));

  const reason = input.failureReason
    ? `<div class="reason"><strong>Reason from the card issuer:</strong> ${escapeHtml(input.failureReason)}</div>`
    : '';
  const retry = input.nextAttemptAt
    ? `<p>We will try the charge again on <strong>${formatDate(input.nextAttemptAt)}</strong>. If it keeps failing, the subscription will be cancelled.</p>`
    : '<p>If the payment is not completed, the subscription will be cancelled.</p>';

  const content = `
          <p>Hello,</p>
          <p>We could not charge the renewal payment for ${plan}.</p>
          ${reason}
          <p>Paid features are paused until the payment goes through. Updating your payment method restores them as soon as the charge succeeds.</p>
          <div style="text-align: center;">
            <a href="${escapeHtml(input.billingUrl)}" class="cta-button">Update payment method</a>
          </div>
          ${retry}
  `;

  return {
    subject: toSubject(`Action needed: ${planNoun(brand, input.organizationName)} payment failed`),
    body: layout(brand, 'Your payment did not go through', content),
  };
};

/** The final notice, sent once when Stripe's retry schedule ends by cancelling the subscription. */
export const buildCanceledForNonPaymentEmail = (input: CanceledForNonPaymentEmailInput): EmailContent => {
  const brand = process.env.APP_NAME || '';
  const plan = escapeHtml(planNoun(brand, input.organizationName));

  const content = `
          <p>Hello,</p>
          <p>We were unable to collect payment for ${plan} after several attempts, so it has been cancelled.</p>
          <p>You can subscribe again at any time.</p>
          <div style="text-align: center;">
            <a href="${escapeHtml(input.billingUrl)}" class="cta-button">View plans</a>
          </div>
  `;

  return {
    subject: toSubject(`${capitalize(planNoun(brand, input.organizationName))} has been cancelled`),
    body: layout(brand, 'Your subscription was cancelled', content),
  };
};
