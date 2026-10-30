import { describe, expect, it } from 'vitest';
import { MeResponseSchema } from './me';

const caller = {
  id: 'user_1',
  name: 'Ada',
  tier: 'free',
  subscription: null,
  credits: { balance: 10 },
  entitlements: [],
};

describe('MeResponseSchema monthly allowance', () => {
  it('accepts a response from a server predating monthly allowances', () => {
    expect(MeResponseSchema.parse(caller).credits).toEqual({ balance: 10 });
  });

  it.each([null, 0, 50_000])('accepts an explicitly stated allowance of %s', monthlyAllowance => {
    expect(
      MeResponseSchema.parse({ ...caller, credits: { balance: 10, monthly_allowance: monthlyAllowance } }).credits
    ).toEqual({ balance: 10, monthly_allowance: monthlyAllowance });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '50000'])(
    'rejects an invalid allowance of %s',
    monthlyAllowance => {
      expect(
        MeResponseSchema.safeParse({ ...caller, credits: { balance: 10, monthly_allowance: monthlyAllowance } }).success
      ).toBe(false);
    }
  );
});
