import { describe, expect, it } from 'vitest';
import { ArtifactOpenStep } from './ArtifactOpenStep';
import { CORE_TUTORIAL_STEPS } from './coreTutorialSteps';
import { ModelSwitchStep } from './ModelSwitchStep';

describe('CORE_TUTORIAL_STEPS', () => {
  it('registers core step renderers', () => {
    expect(CORE_TUTORIAL_STEPS['model-switch']).toBe(ModelSwitchStep);
    expect(CORE_TUTORIAL_STEPS['artifact-open']).toBe(ArtifactOpenStep);
  });
});
