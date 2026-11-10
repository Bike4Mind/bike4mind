import { test } from '../fixtures';
import { guardLaunchReadiness } from './guard';

guardLaunchReadiness();

const NO_EVENT_TRIGGER =
  'Needs a Stripe test event delivered to the staging webhook, which only the Stripe CLI or a test-mode secret key can trigger; this suite holds neither';

test.describe('A3.3 processor risk events', () => {
  test('A3.3 an early fraud warning locks the account and refunds the charge without a human', async () => {
    test.skip(true, `${NO_EVENT_TRIGGER} (radar.early_fraud_warning.created)`);
  });

  test('A3.3 a full refund or a lost dispute revokes paid standing', async () => {
    test.skip(true, `${NO_EVENT_TRIGGER} (charge.refunded, charge.dispute.closed)`);
  });
});
