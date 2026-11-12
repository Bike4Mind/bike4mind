import type { EvalCohort, VerdictEvalGrader } from '@client/app/utils/verdictEval';

export const GRADER_LABELS: Record<VerdictEvalGrader, string> = {
  assessment: 'AI assessment',
  containment: 'Auto-containment',
  signupVerdict: 'Signup verdict',
  detectors: 'Detectors',
};

export const COHORT_LABELS: Record<EvalCohort, string> = {
  mobile: 'Mobile or tablet',
  sharedNetwork: 'Shared signup network',
  apiAgent: 'API, agent or CLI use',
  assistive: 'Assistive technology',
};
