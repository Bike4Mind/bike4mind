/**
 * The live half of the abstention eval. Skips cleanly unless `ABSTENTION_EVAL_BASE_URL` and
 * `ABSTENTION_EVAL_MODEL` are set, so `pnpm turbo:test` stays deterministic - prompt behaviour is a
 * measurement, not a merge gate. See README.md in this directory for how to run it.
 */
import { describe, expect, it } from 'vitest';
import { ABSTENTION_CASES } from './cases';
import { MIN_PASS_RATE, formatAbstentionReport, runAbstentionEval } from './run';

const baseUrl = process.env.ABSTENTION_EVAL_BASE_URL;
const model = process.env.ABSTENTION_EVAL_MODEL;
const samples = Number(process.env.ABSTENTION_EVAL_SAMPLES ?? '3');

// A bad sample count must not read as a clean run: at 0 (or `NaN`, from `ABSTENTION_EVAL_SAMPLES=two`)
// every passRate comes out `0/0 = NaN`, no comparison against it is ever true, and the suite goes
// green having called the model zero times while the printed report says FAIL on every case.
if (baseUrl && model && (!Number.isInteger(samples) || samples < 1)) {
  throw new Error(`ABSTENTION_EVAL_SAMPLES must be a positive integer, got: ${process.env.ABSTENTION_EVAL_SAMPLES}`);
}

describe.skipIf(!baseUrl || !model)('forced-retrieval abstention (live model)', () => {
  it(
    'no-ops on turns that do not depend on the library, and hedges per finding on turns that do',
    async () => {
      const results = await runAbstentionEval({ baseUrl: baseUrl!, model: model!, samples }, ABSTENTION_CASES);
      // The report is the deliverable - a bare pass/fail on a stochastic suite is not actionable.
      console.log(`\n${model} @ ${samples} samples/case\n${formatAbstentionReport(results)}\n`);

      const regressed = results.filter(r => r.passRate < MIN_PASS_RATE);
      expect(regressed.map(r => `${r.caseId}: ${r.samples.find(s => !s.passed)?.reason}`)).toEqual([]);
    },
    // A full sweep is cases x samples sequential completions; a local model needs the headroom.
    10 * 60 * 1000
  );
});
