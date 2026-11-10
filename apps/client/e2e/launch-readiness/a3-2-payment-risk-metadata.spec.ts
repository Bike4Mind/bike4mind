import { test } from '../fixtures';
import { guardLaunchReadiness } from './guard';

guardLaunchReadiness();

test.describe('A3.2 payment risk metadata', () => {
  test('A3.2 a payment intent carries the account-age and signup-network metadata keys', async () => {
    test.skip(
      true,
      'The keys are written onto the Stripe PaymentIntent server-side and no app route returns them; reading them back needs a Stripe test-mode secret key, which this suite does not hold'
    );
  });
});
