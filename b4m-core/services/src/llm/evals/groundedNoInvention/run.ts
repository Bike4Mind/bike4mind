/**
 * The grounded-no-invention eval, as a definition the shared harness runs. Everything generic - the
 * endpoint call, sampling, the blank-completion guard, the report - lives in `../harness`; what is
 * specific here is the retrieved-content wrapper the rule is spliced into (`./corpus`) and which
 * grader each expectation wants.
 *
 * Not run in CI - it needs a live endpoint and prompt behaviour is not a green/red gate. See README.
 */

import { runPromptEval, type PromptEvalCaseResult, type PromptEvalConfig, type PromptEvalDefinition } from '../harness';
import { GROUNDED_CASES, type GroundedCase } from './cases';
import { groundedSystemPrompt } from './corpus';
import { gradeMustAnswer, gradeMustNotDenyPremise, type GradeResult } from './grade';

// Grade type pinned explicitly (rather than the harness's EvalGrade default) so `claims` survives
// into PromptEvalCaseResult - formatEvalReport printing what a sample was graded on is the obvious
// next want, and the old AbstentionCaseResult carried them.
// `rule` threads through to `groundedSystemPrompt`, which already defaults to the shipped rule - the
// A/B seam this eval was built for, so a candidate reword can run against the same cases and corpus as
// the shipped one instead of only ever being reasoned about. See run.live.test.ts for the paired run.
export const groundedNoInventionEval = (
  cases: GroundedCase[],
  rule?: string
): PromptEvalDefinition<GroundedCase, GradeResult> => ({
  cases,
  // One corpus for every case: the control and the derive case have to see the same retrieved content
  // as the premise-challenge cases, or they are not measuring the same rule in the same context.
  systemPrompt: () => groundedSystemPrompt(rule),
  grade: (evalCase, reply) =>
    evalCase.expectation.kind === 'mustNotDenyPremise'
      ? // The message, not just the reply: both closed-world checks license the figures the QUESTION
        // itself asserts, so a reply repeating one back is not scored as having supplied it.
        gradeMustNotDenyPremise(reply, evalCase.message)
      : gradeMustAnswer(reply, evalCase.expectation.expected, evalCase.message),
  gradeEmpty: reason => ({ passed: false, reason, claims: [] }),
});

export function runGroundedNoInventionEval(
  config: PromptEvalConfig,
  cases: GroundedCase[] = GROUNDED_CASES,
  rule?: string
): Promise<PromptEvalCaseResult<GroundedCase, GradeResult>[]> {
  return runPromptEval(config, groundedNoInventionEval(cases, rule));
}
