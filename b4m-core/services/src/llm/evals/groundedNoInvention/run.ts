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
export const groundedNoInventionEval = (cases: GroundedCase[]): PromptEvalDefinition<GroundedCase, GradeResult> => ({
  cases,
  // One corpus for every case: the control and the derive case have to see the same retrieved content
  // as the premise-challenge cases, or they are not measuring the same rule in the same context.
  systemPrompt: () => groundedSystemPrompt(),
  grade: (evalCase, reply) =>
    evalCase.expectation.kind === 'mustNotDenyPremise'
      ? gradeMustNotDenyPremise(reply)
      : gradeMustAnswer(reply, evalCase.expectation.expected),
  gradeEmpty: reason => ({ passed: false, reason, claims: [] }),
});

export function runGroundedNoInventionEval(
  config: PromptEvalConfig,
  cases: GroundedCase[] = GROUNDED_CASES
): Promise<PromptEvalCaseResult<GroundedCase, GradeResult>[]> {
  return runPromptEval(config, groundedNoInventionEval(cases));
}
