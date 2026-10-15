import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCanceledForNonPaymentEmail, buildPaymentFailedEmail } from './paymentFailedEmail';

const BILLING_URL = 'https://app.example.com/billing/plans';

describe('buildPaymentFailedEmail', () => {
  const originalBrand = process.env.APP_NAME;

  beforeEach(() => {
    process.env.APP_NAME = 'Acme';
  });

  afterEach(() => {
    process.env.APP_NAME = originalBrand;
  });

  it('links to the billing page and names the brand in the subject', () => {
    const { subject, body } = buildPaymentFailedEmail({ billingUrl: BILLING_URL });

    expect(subject).toBe('Action needed: your Acme subscription payment failed');
    expect(body).toContain(`href="${BILLING_URL}"`);
    expect(body).toContain('your Acme subscription');
  });

  it('says paid features are paused now, not at cancellation', () => {
    const { body } = buildPaymentFailedEmail({ billingUrl: BILLING_URL });

    expect(body).toContain('Paid features are paused until the payment goes through');
  });

  it('escapes the card issuer reason, which comes from Stripe', () => {
    const { body } = buildPaymentFailedEmail({
      billingUrl: BILLING_URL,
      failureReason: 'Your card was declined. <script>x</script>',
    });

    expect(body).toContain('Your card was declined. &lt;script&gt;x&lt;/script&gt;');
    expect(body).not.toContain('<script>x</script>');
  });

  it('omits the reason block when Stripe gave no reason', () => {
    const { body } = buildPaymentFailedEmail({ billingUrl: BILLING_URL, failureReason: null });

    expect(body).not.toContain('Reason from the card issuer');
  });

  it('gives the retry date when one is scheduled', () => {
    const { body } = buildPaymentFailedEmail({
      billingUrl: BILLING_URL,
      nextAttemptAt: new Date('2026-10-20T12:00:00Z'),
    });

    expect(body).toContain('October 20, 2026');
  });

  it('names and escapes the organization for an org subscription', () => {
    const { body } = buildPaymentFailedEmail({ billingUrl: BILLING_URL, organizationName: 'R&D <Team>' });

    expect(body).toContain('the R&amp;D &lt;Team&gt; subscription');
  });
});

describe('buildCanceledForNonPaymentEmail', () => {
  it('links to the billing page', () => {
    const { subject, body } = buildCanceledForNonPaymentEmail({ billingUrl: BILLING_URL });

    expect(subject).toContain('has been cancelled');
    expect(body).toContain(`href="${BILLING_URL}"`);
  });
});
