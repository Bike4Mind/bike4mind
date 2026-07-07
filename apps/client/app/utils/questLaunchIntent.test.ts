import { describe, it, expect } from 'vitest';
import { consumeQuestLaunchIntent, setQuestLaunchIntent } from './questLaunchIntent';

describe('questLaunchIntent', () => {
  it('returns null when no intent is pending', () => {
    expect(consumeQuestLaunchIntent()).toBeNull();
  });

  it('returns the recorded intent', () => {
    const intent = { goal: 'Build a birdhouse', autoSubmit: true, enableQuestMaster: true };
    setQuestLaunchIntent(intent);

    expect(consumeQuestLaunchIntent()).toEqual(intent);
  });

  it('consumes exactly once - second read returns null', () => {
    setQuestLaunchIntent({ goal: 'Plan a trip', autoSubmit: true, enableQuestMaster: false });

    expect(consumeQuestLaunchIntent()).not.toBeNull();
    expect(consumeQuestLaunchIntent()).toBeNull();
  });

  it('a newer intent replaces an unconsumed one', () => {
    setQuestLaunchIntent({ goal: 'first', autoSubmit: true, enableQuestMaster: false });
    setQuestLaunchIntent({ goal: 'second', autoSubmit: false, enableQuestMaster: true });

    expect(consumeQuestLaunchIntent()).toEqual({ goal: 'second', autoSubmit: false, enableQuestMaster: true });
  });
});
