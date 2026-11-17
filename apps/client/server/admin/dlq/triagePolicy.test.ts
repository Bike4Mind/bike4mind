import { describe, expect, it } from 'vitest';
import { recommendDlqAction } from './triagePolicy';
import type { IDlqFailure } from '@bike4mind/database';

const failure = (fields: Partial<IDlqFailure>): IDlqFailure => ({
  queueLabel: 'source',
  messageId: 'm1',
  errorType: 'Error',
  errorMessage: 'private content',
  category: 'unknown',
  failedAt: new Date(),
  consumerVersion: '$LATEST',
  ...fields,
});
const input = { queueLabel: 'fixture', messageId: 'm1', sourceQueue: 'source', replay: 'safe' as const };

describe('DLQ recommendation policy', () => {
  it('does not trust a broad refusal or timeout category for an actionable recommendation', () => {
    for (const category of ['refused', 'timeout'] as const) {
      expect(recommendDlqAction({ ...input, failure: failure({ category }) }).action).toBe('investigate');
    }
  });
  it('recommends discard only with the trusted terminal signal', () => {
    expect(recommendDlqAction({ ...input, failure: failure({ terminalRefusal: true }) })).toMatchObject({
      action: 'discard',
      risk: 'terminal-refusal',
    });
  });
  it.each(['side-effects', 'unsafe'] as const)('never recommends transient replay on %s', replay => {
    expect(recommendDlqAction({ ...input, replay, failure: failure({ transientFailure: true }) }).action).toBe(
      'investigate'
    );
  });
  it('recommends a safe transient retry only with a destination', () => {
    expect(recommendDlqAction({ ...input, failure: failure({ transientFailure: true }) }).action).toBe('replay');
    expect(
      recommendDlqAction({ ...input, sourceQueue: null, failure: failure({ transientFailure: true }) }).action
    ).toBe('investigate');
  });
  it('keeps private error text out of the explanation', () => {
    expect(JSON.stringify(recommendDlqAction({ ...input, failure: failure({ terminalRefusal: true }) }))).not.toContain(
      'private content'
    );
  });
});
