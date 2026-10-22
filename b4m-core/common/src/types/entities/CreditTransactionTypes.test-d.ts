import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { GenericCreditDeductTransaction, GenericDeductReason } from '../../index';

// Augments the package barrel, which is what `declare module '@bike4mind/common'` resolves to.
declare module '../../index' {
  interface GenericDeductReasonExtensions {
    typetest_extension_reason: true;
  }
}

describe('GenericDeductReason extension point', () => {
  it('admits a reason added through declaration merging', () => {
    expectTypeOf<'typetest_extension_reason'>().toExtend<GenericDeductReason>();
    expectTypeOf<'typetest_extension_reason'>().toExtend<
      NonNullable<z.infer<typeof GenericCreditDeductTransaction>['reason']>
    >();
  });

  it('keeps the built-in reasons and still rejects an unknown one', () => {
    expectTypeOf<'admin_adjustment'>().toExtend<GenericDeductReason>();
    expectTypeOf<'typetest_unregistered_reason'>().not.toExtend<GenericDeductReason>();
  });
});
