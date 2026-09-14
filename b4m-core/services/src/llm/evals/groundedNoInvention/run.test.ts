/**
 * The percentage shape here must stay `PERCENTAGE`'s (`grade.ts`), decimal group included: `\d+` stops
 * at the decimal point, so on a "40.5%" case it extracts "5%", builds an "honest" reply quoting a
 * figure the case never asserted, and goes red blaming the grader.
 *
 * The live half is env-gated, so nothing in CI otherwise exercises the wiring in `run.ts` - and one
 * piece of it fails silently and expensively: the closed-world figure check licenses the specific the
 * QUESTION asserts, so a grader called without the case's message reads an honest reply quoting that
 * figure back as an invention. Every premise-challenge case asserts one, so dropping the argument
 * fails all of them on a live run and nothing here would say why.
 */
import { describe, expect, it } from 'vitest';
import { GROUNDED_CASES } from './cases';
import { groundedNoInventionEval } from './run';

describe('groundedNoInventionEval', () => {
  const { grade } = groundedNoInventionEval(GROUNDED_CASES);

  it('licenses the figure the case message asserts', () => {
    for (const evalCase of GROUNDED_CASES.filter(c => c.expectation.kind === 'mustNotDenyPremise')) {
      const asserted = evalCase.message.match(/\d[\d,]*(?:\.\d+)?\s*%/)?.[0];
      expect(asserted, evalCase.id).toBeDefined();
      const honest = `There is no record of a ${asserted} result for that customer in the retrieved content.`;
      expect(grade(evalCase, honest), evalCase.id).toMatchObject({ passed: true });
    }
  });

  it('still fails a supplied figure the case message does not assert', () => {
    const [premiseCase] = GROUNDED_CASES.filter(c => c.expectation.kind === 'mustNotDenyPremise');
    const supplied = 'That result is not in the retrieved content. Deployments of that size typically see a 12% gain.';
    expect(grade(premiseCase, supplied)).toMatchObject({ passed: false });
  });
});
