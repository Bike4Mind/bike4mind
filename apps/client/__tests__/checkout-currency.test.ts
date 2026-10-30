// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkoutUsdAmountPattern } from '../e2e/helpers/checkout-currency';

describe('checkoutUsdAmountPattern', () => {
  it.each(['$150', 'US$150', '$150.00', 'US$150.00', 'Total: $150.00 per month'])('matches %s', text => {
    expect(text).toMatch(checkoutUsdAmountPattern(150));
  });

  it.each(['$1500.00', '$150.99', '$150.001', '$150,000', 'CA$150.00', 'A$150.00', 'NZ$150.00'])('rejects %s', text => {
    expect(text).not.toMatch(checkoutUsdAmountPattern(150));
  });

  it.each(['$150.50', 'US$150.50'])('matches fractional total %s', text => {
    expect(text).toMatch(checkoutUsdAmountPattern(150.5));
  });

  it.each(['$150X5', '$150.5', '$150.500', '$150.59', 'CA$150.50', 'A$150.50'])(
    'rejects fractional mismatch %s',
    text => {
      expect(text).not.toMatch(checkoutUsdAmountPattern(150.5));
    }
  );

  it.each(['$1500.00', '$1,500.00', 'US$1,500'])('matches grouped amount %s', text => {
    expect(text).toMatch(checkoutUsdAmountPattern(1500));
  });

  it.each([NaN, Infinity, -1])('rejects invalid total %s', total => {
    expect(() => checkoutUsdAmountPattern(total)).toThrow('Invalid checkout total');
  });
});
