// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { MIN_PRICE_PER_CREDIT_USD } from '@bike4mind/common';
import { CREDIT_PACKAGES } from './constants';
import { packageSchema } from './schemas';
import { CreditPackageId, TransactionType } from './types';

describe('CREDIT_PACKAGES', () => {
  it('sells three packs at $20, $50 and $100 in ascending order', () => {
    expect(Object.values(CREDIT_PACKAGES).map(pack => [pack.id, pack.price, pack.credits])).toEqual([
      ['package_25k', 20, 33333],
      ['package_usd50', 50, 83333],
      ['package_usd100', 100, 166667],
    ]);
  });

  it('derives credits from the platform per-credit rate', () => {
    for (const pack of Object.values(CREDIT_PACKAGES)) {
      expect(pack.credits).toBe(Math.round(pack.price / MIN_PRICE_PER_CREDIT_USD));
    }
  });

  it('keys each pack by its own id', () => {
    for (const [key, pack] of Object.entries(CREDIT_PACKAGES)) {
      expect(pack.id).toBe(key);
    }
  });

  it('does not offer the retired $10 and $35 packs', () => {
    expect(CREDIT_PACKAGES).not.toHaveProperty('package_10k');
    expect(CREDIT_PACKAGES).not.toHaveProperty('package_50k');
    expect(Object.values(CreditPackageId)).not.toContain('package_10k');
    expect(Object.values(CreditPackageId)).not.toContain('package_50k');
  });

  it('rejects a retired pack id at the start-payment schema', () => {
    for (const packageId of ['package_10k', 'package_50k']) {
      expect(packageSchema.safeParse({ transactionType: TransactionType.Package, packageId }).success).toBe(false);
    }
    expect(
      packageSchema.safeParse({ transactionType: TransactionType.Package, packageId: CreditPackageId.Usd20 }).success
    ).toBe(true);
  });
});
