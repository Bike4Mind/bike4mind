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
// A candidate rule text to A/B against the shipped one. Optional, and unset is the merge-gate
// configuration (shipped rule only) - this is the seam `groundedSystemPrompt`'s default parameter
// exists for: a reword's own docblock asks for a measurement against the text it would replace, not a
// reasoned-through judgment call.
const candidateRule = process.env.GROUNDED_EVAL_CANDIDATE_RULE;
// Optional, because the documented local recipe (Ollama) needs no auth - but a hosted endpoint does,
// and without this the suite could only ever be pointed at a keyless one. The harness puts it in an
// Authorization header and its error paths print only the model and the response body, so a failing
// run cannot echo it.
const apiKey = process.env.GROUNDED_EVAL_API_KEY;

// Generous per completion on purpose: a local model on CPU is the slow end of what this suite is
// pointed at, and overrunning the budget throws away the whole sweep rather than one sample.
const PER_COMPLETION_BUDGET_MS = 10 * 1000;

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
      const results = await runGroundedNoInventionEval(
        { baseUrl: baseUrl!, model: model!, samples, apiKey },
        GROUNDED_CASES
      );
      // The report is the deliverable - a bare pass/fail on a stochastic suite is not actionable.
      console.log(`\n${model} @ ${samples} samples/case (shipped rule)\n${formatEvalReport(results)}\n`);

      const regressed = results.filter(r => r.passRate < MIN_PASS_RATE);
      expect(regressed.map(r => `${r.evalCase.id}: ${r.samples.find(s => !s.passed)?.reason}`)).toEqual([]);

      // Reported, not gated: this arm exists to compare against the shipped one above, and a candidate
      // under active development is expected to fail cases the shipped rule already passes.
      if (!candidateRule) return;
      const candidateResults = await runGroundedNoInventionEval(
        { baseUrl: baseUrl!, model: model!, samples, apiKey },
        GROUNDED_CASES,
        candidateRule
      );
      console.log(`\n${model} @ ${samples} samples/case (candidate rule)\n${formatEvalReport(candidateResults)}\n`);
    },
    // The harness sends cases x samples sequentially, twice over when a candidate arm is set, so the
    // budget has to scale with the sweep rather than sit at a constant: the default 3 samples is 27
    // completions, but the sample count an A/B is actually worth reading at is 30, which is 540 - and
    // a fixed 10 minutes killed that run partway through, discarding every completion already paid for.
    GROUNDED_CASES.length * samples * (candidateRule ? 2 : 1) * PER_COMPLETION_BUDGET_MS + 60 * 1000
  );
});
