import { describe, expect, it } from 'vitest';
import { CORE_TUTORIAL_STEPS } from './coreTutorialSteps';
import { ModelSwitchStep } from './ModelSwitchStep';

describe('CORE_TUTORIAL_STEPS', () => {
  it('registers the model-switch renderer', () => {
    expect(CORE_TUTORIAL_STEPS['model-switch']).toBe(ModelSwitchStep);
  });
});
