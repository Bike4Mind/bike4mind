/**
 * The live half of the abstention eval. Skips cleanly unless `ABSTENTION_EVAL_BASE_URL` and
 * `ABSTENTION_EVAL_MODEL` are set, so `pnpm turbo:test` stays deterministic - prompt behaviour is a
 * measurement, not a merge gate. See README.md in this directory for how to run it.
 */
import { describe, expect, it } from 'vitest';
import { ABSTENTION_CASES } from './cases';
import { formatAbstentionReport, runAbstentionEval } from './run';

const baseUrl = process.env.ABSTENTION_EVAL_BASE_URL;
const model = process.env.ABSTENTION_EVAL_MODEL;
const samples = Number(process.env.ABSTENTION_EVAL_SAMPLES ?? '3');

describe.skipIf(!baseUrl || !model)('forced-retrieval abstention (live model)', () => {
  it(
    'no-ops on turns that do not depend on the library, and hedges per finding on turns that do',
    async () => {
      const results = await runAbstentionEval({ baseUrl: baseUrl!, model: model!, samples }, ABSTENTION_CASES);
      // The report is the deliverable - a bare pass/fail on a stochastic suite is not actionable.
      console.log(`\n${model} @ ${samples} samples/case\n${formatAbstentionReport(results)}\n`);

      const flaky = results.filter(r => r.passRate < 1);
      expect(flaky.map(r => `${r.caseId}: ${r.samples.find(s => !s.passed)?.reason}`)).toEqual([]);
    },
    // A full sweep is cases x samples sequential completions; a local model needs the headroom.
    10 * 60 * 1000
  );
});
