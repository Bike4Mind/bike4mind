import { PointStep } from '../genericSteps';
import type { TutorialStepProps } from '../types';

/** What a step type with no registered renderer shows, so the user can still move on. */
export function StepFallback(props: TutorialStepProps) {
  return <PointStep {...props} />;
}
