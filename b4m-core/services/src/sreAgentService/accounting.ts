import { createHash } from 'node:crypto';
import type { IPlatformAttribution } from '@bike4mind/common';
import {
  PlatformCompletionAccountingError,
  PlatformCompletionMeter,
  type PlatformCompletionAccountingContext,
} from '../billing/platformCompletionMeter';

export type SreAccountingContext = PlatformCompletionAccountingContext;

const accountingFailure = Symbol.for('bike4mind.sre.accounting.failure');

export class SreAccountingError extends PlatformCompletionAccountingError {
  readonly [accountingFailure] = true;

  constructor(reason: string, providerCallId?: string, options?: ErrorOptions) {
    super(reason, providerCallId, options);
    this.name = 'SreAccountingError';
    this.message = 'SRE accounting requires durable recovery';
  }
}

export function isSreAccountingError(error: unknown): error is SreAccountingError {
  return error instanceof Error && accountingFailure in error && error[accountingFailure] === true;
}

export class SreCompletionMeter extends PlatformCompletionMeter {
  private ordinal = 0;

  protected override createError(reason: string, providerCallId?: string, options?: ErrorOptions): SreAccountingError {
    return new SreAccountingError(reason, providerCallId, options);
  }

  protected override createProviderCallId(attribution: IPlatformAttribution): string {
    if (attribution.operation !== 'sre_diagnosis') throw this.createError('invalid_attribution');
    return createHash('sha256')
      .update(attribution.executionId + ':sre:' + ++this.ordinal)
      .digest('hex');
  }
}
