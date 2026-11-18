import { describe, expect, it } from 'vitest';
import { localRunSettlement } from './runSpend';

const RUN = 'run-a';

describe('localRunSettlement', () => {
  it('sums the charges settled under the run, on messages and on rounds', () => {
    const local = localRunSettlement(
      [
        { requestId: 'r1', settled: { creditsCharged: 2, runId: RUN } },
        {
          rounds: [
            { text: '', toolCallIds: [], requestId: 'r2', settled: { creditsCharged: 3, runId: RUN } },
            { text: '', toolCallIds: [], requestId: 'r3', settled: { creditsCharged: 4, runId: RUN } },
          ],
        },
      ],
      RUN
    );
    expect(local).toEqual({ creditsCharged: 9, requests: 3 });
  });

  it('counts a request once when it appears twice', () => {
    const message = { requestId: 'r1', settled: { creditsCharged: 5, runId: RUN } };
    expect(localRunSettlement([message, { ...message }], RUN)).toEqual({ creditsCharged: 5, requests: 1 });
  });

  it('leaves out charges from another run or from no run, so reused conversations add nothing', () => {
    const local = localRunSettlement(
      [
        { requestId: 'old', settled: { creditsCharged: 40 } },
        { requestId: 'other', settled: { creditsCharged: 7, runId: 'run-b' } },
        { requestId: 'r1', settled: { creditsCharged: 1, runId: RUN } },
        { requestId: 'unsettled' },
      ],
      RUN
    );
    expect(local).toEqual({ creditsCharged: 1, requests: 1 });
  });
});
