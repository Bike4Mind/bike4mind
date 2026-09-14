/**
 * The forced-retrieval abstention eval, as a definition the shared driver runs. Everything generic -
 * the endpoint call, sampling, the blank-completion guard, the report - lives in
 * `../harness`; what is specific to this eval is the prompt body (selected by the case's
 * finding) and which grader each expectation wants.
 *
 * Not run in CI - it needs a live endpoint and prompt behaviour is not a green/red gate. See README.
 */

import { forcedRetrievalNoContextPrompt } from '../../forcedRetrievalAbstention';
import { runPromptEval, type PromptEvalCaseResult, type PromptEvalConfig, type PromptEvalDefinition } from '../harness';
import { ABSTENTION_CASES, type AbstentionCase } from './cases';
import { gradeMustHedge, gradeMustNotMentionCoverage, type GradeResult } from './grade';

// Grade type pinned for the same reason `../groundedNoInvention/run.ts` pins it: left at the
// harness's EvalGrade default, `claims` is statically lost for the eval whose own predecessor type
// carried them, which is the reason that file gives for pinning.
export const abstentionEval = (cases: AbstentionCase[]): PromptEvalDefinition<AbstentionCase, GradeResult> => ({
  cases,
  systemPrompt: evalCase => forcedRetrievalNoContextPrompt(evalCase.finding),
  grade: (evalCase, reply) =>
    evalCase.expectation.kind === 'mustNotMentionCoverage'
      ? gradeMustNotMentionCoverage(reply)
      : gradeMustHedge(reply, evalCase.finding),
  gradeEmpty: reason => ({ passed: false, reason, claims: [] }),
});

export function runAbstentionEval(
  config: PromptEvalConfig,
  cases: AbstentionCase[] = ABSTENTION_CASES
): Promise<PromptEvalCaseResult<AbstentionCase, GradeResult>[]> {
  return runPromptEval(config, abstentionEval(cases));
}
