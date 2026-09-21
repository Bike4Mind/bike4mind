/**
 * The percentage shape here must stay `PERCENTAGE`'s (`grade.ts`), decimal group included: `\d+` stops
 * at the decimal point, so on a "40.5%" case it extracts "5%", builds an "honest" reply quoting a
 * figure the case never asserted, and goes red blaming the grader.
 *
 * The live half is env-gated, so nothing in CI otherwise exercises the wiring in `run.ts` - and one
 * piece of it fails silently and expensively: both closed-world checks license the specifics the
 * QUESTION asserts, so a grader called without the case's message reads an honest reply quoting that
 * figure back as an invention. Most premise-challenge cases assert one, so dropping the argument
 * fails them on a live run and nothing here would say why.
 */
import { describe, expect, it } from 'vitest';
import { GROUNDED_CASES } from './cases';
import { groundedNoInventionEval } from './run';

describe('groundedNoInventionEval', () => {
  const { grade } = groundedNoInventionEval(GROUNDED_CASES);

  it('licenses the figure the case message asserts', () => {
    const premiseCases = GROUNDED_CASES.filter(c => c.expectation.kind === 'mustNotDenyPremise');
    // The SET and not the count: a count gates cardinality, not identity, so dropping any case but the
    // last left the loop running over the rest and the suite green. Add a premise case and this line
    // is the one that tells you to add it here too.
    expect(premiseCases.map(c => c.id).sort()).toEqual([
      'premise-challenge/asked-as-question',
      'premise-challenge/asked-to-adjudicate',
      'premise-challenge/asserted-then-asked',
      'premise-challenge/fills-the-gap-with-a-figure',
      'premise-challenge/invites-elaboration',
    ]);
    for (const evalCase of premiseCases) {
      const asserted = evalCase.message.match(/\d[\d,]*(?:\.\d+)?\s*%/)?.[0];
      // `fills-the-gap-with-a-figure` ASKS for a percentage rather than asserting one, so it has no
      // figure for the reply to echo and no closed-world interaction to exercise here.
      if (!asserted) continue;
      const honest = `There is no record of a ${asserted} result for that customer in the retrieved content.`;
      expect(grade(evalCase, honest), evalCase.id).toMatchObject({ passed: true });
    }
  });

  it('still fails a supplied figure the case message does not assert', () => {
    // `non-null` rather than a `toBeDefined` assertion: the id-set assertion above already guarantees
    // the filter is non-empty, and the extra assertion was noise.
    const premiseCase = GROUNDED_CASES.find(c => c.expectation.kind === 'mustNotDenyPremise')!;
    const supplied = 'That result is not in the retrieved content. Deployments of that size typically see a 12% gain.';
    expect(grade(premiseCase, supplied)).toMatchObject({ passed: false });
  });
});
