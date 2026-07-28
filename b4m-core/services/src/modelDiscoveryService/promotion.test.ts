import { ModelBackend } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { testCredentials, testRecord } from './__fixtures__/fakes';
import { AWAITING_APPROVAL_REASON, AWAITING_PRICE_REASON, NOT_INVOCABLE_REASON, evaluatePromotion } from './promotion';
import type { PromotionInput } from './promotion';

const evaluate = (overrides: Partial<PromotionInput> = {}) =>
  evaluatePromotion({
    record: testRecord(),
    policy: 'priced',
    credentials: testCredentials(),
    hasTrustedPrice: true,
    ...overrides,
  });

describe('evaluatePromotion', () => {
  it('promotes when every clause of the invocability contract holds', () => {
    expect(evaluate()).toEqual({ promote: true, blockedBy: [] });
  });

  it('blocks a record with no adapter family', () => {
    const decision = evaluate({ record: testRecord({ adapterFamily: undefined }) });

    expect(decision.promote).toBe(false);
    expect(decision.blockedBy).toEqual(['no-adapter-family']);
    expect(decision.autoDisabledReason).toBe(NOT_INVOCABLE_REASON);
  });

  it('blocks a family this build cannot dispatch', () => {
    // voyageai is the one declared family with no completion backend; the
    // bedrock-* families became dispatchable when family dispatch shipped.
    const record = testRecord({ backend: ModelBackend.Bedrock, adapterFamily: 'voyageai' });

    expect(evaluate({ record }).blockedBy).toEqual(['family-not-dispatchable']);
  });

  it('promotes a Bedrock record now that family dispatch routes it', () => {
    const record = testRecord({ backend: ModelBackend.Bedrock, adapterFamily: 'bedrock-anthropic' });

    expect(evaluate({ record })).toEqual({ promote: true, blockedBy: [] });
  });

  it('blocks a record with no dispatch profile', () => {
    expect(evaluate({ record: testRecord({ dispatchProfile: undefined }) }).blockedBy).toEqual(['no-dispatch-profile']);
  });

  it('blocks an effort-style reasoner whose profile has no effort map', () => {
    const record = testRecord({
      reasoning: { supported: true, style: 'openai-effort', effortLevels: ['low', 'high'] },
    });

    expect(evaluate({ record }).blockedBy).toEqual(['incomplete-dispatch-profile']);
  });

  it('blocks an unpriced model under the priced policy', () => {
    const decision = evaluate({ hasTrustedPrice: false });

    expect(decision.blockedBy).toEqual(['no-trusted-price']);
    expect(decision.autoDisabledReason).toBe(AWAITING_PRICE_REASON);
  });

  it('promotes an unpriced model that cannot cost anything', () => {
    expect(evaluate({ hasTrustedPrice: false, record: testRecord({ freeToRun: true }) }).promote).toBe(true);
  });

  it('blocks everything under the manual policy', () => {
    const decision = evaluate({ policy: 'manual' });

    expect(decision.blockedBy).toEqual(['manual-approval-required']);
    expect(decision.autoDisabledReason).toBe(AWAITING_APPROVAL_REASON);
  });

  it('still refuses a missing dispatch profile under the all policy', () => {
    const decision = evaluate({
      policy: 'all',
      hasTrustedPrice: false,
      record: testRecord({ dispatchProfile: undefined }),
    });

    expect(decision.blockedBy).toEqual(['no-dispatch-profile']);
  });

  it('blocks when the deployment has no credential for the backend', () => {
    const decision = evaluate({ credentials: testCredentials({ openai: null }) });

    expect(decision.blockedBy).toEqual(['no-credential-for-backend']);
  });

  it('treats Bedrock as credential-free when hosted and unconfigured under self-host', () => {
    // The family clause is the Bedrock blocker either way; only the credential
    // clause is under test, so it is asserted by membership rather than equality.
    const record = testRecord({ backend: ModelBackend.Bedrock, adapterFamily: 'anthropic-messages' });

    expect(evaluate({ record }).blockedBy).not.toContain('no-credential-for-backend');
    expect(evaluate({ record, credentials: testCredentials({ awsIam: false }) }).blockedBy).toContain(
      'no-credential-for-backend'
    );
  });

  it('reports every failed clause, not just the first', () => {
    const decision = evaluate({
      record: testRecord({ adapterFamily: undefined, dispatchProfile: undefined }),
      hasTrustedPrice: false,
      credentials: testCredentials({ openai: null }),
    });

    expect(decision.blockedBy).toEqual([
      'no-adapter-family',
      'no-dispatch-profile',
      'no-trusted-price',
      'no-credential-for-backend',
    ]);
  });
});
