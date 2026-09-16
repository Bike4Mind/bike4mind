/**
 * The live half of the grounded-no-invention eval. Skips cleanly unless `GROUNDED_EVAL_BASE_URL` and
 * `GROUNDED_EVAL_MODEL` are set, so `pnpm turbo:test` stays deterministic - prompt behaviour is a
 * measurement, not a merge gate. See README.md in this directory for how to run it.
 */
import { describe, expect, it } from 'vitest';
import { MIN_PASS_RATE, formatEvalReport } from '../harness';
import { GROUNDED_CASES } from './cases';
import { runGroundedNoInventionEval } from './run';

const baseUrl = process.env.GROUNDED_EVAL_BASE_URL;
const model = process.env.GROUNDED_EVAL_MODEL;
const samples = Number(process.env.GROUNDED_EVAL_SAMPLES ?? '3');

// A bad sample count must not read as a clean run: at 0 (or `NaN`, from `GROUNDED_EVAL_SAMPLES=two`)
// every passRate comes out `0/0 = NaN`, no comparison against it is ever true, and the suite goes
// green having called the model zero times while the printed report says FAIL on every case.
if (baseUrl && model && (!Number.isInteger(samples) || samples < 1)) {
  throw new Error(`GROUNDED_EVAL_SAMPLES must be a positive integer, got: ${process.env.GROUNDED_EVAL_SAMPLES}`);
}

describe.skipIf(!baseUrl || !model)('grounded no-invention rule (live model)', () => {
  it(
    'scopes corpus absence without ruling on the premise, and still answers what the content supports',
    async () => {
      const results = await runGroundedNoInventionEval({ baseUrl: baseUrl!, model: model!, samples }, GROUNDED_CASES);
      // The report is the deliverable - a bare pass/fail on a stochastic suite is not actionable.
      console.log(`\n${model} @ ${samples} samples/case\n${formatEvalReport(results)}\n`);

      const regressed = results.filter(r => r.passRate < MIN_PASS_RATE);
      expect(regressed.map(r => `${r.evalCase.id}: ${r.samples.find(s => !s.passed)?.reason}`)).toEqual([]);
    },
    // A full sweep is cases x samples sequential completions; a local model needs the headroom.
    10 * 60 * 1000
  );
});
