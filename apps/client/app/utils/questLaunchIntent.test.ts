import { describe, it, expect } from 'vitest';
import {
  consumeQuestLaunchIntent,
  setQuestLaunchIntent,
  armTrustedQuestLaunch,
  consumeTrustedQuestLaunch,
} from './questLaunchIntent';

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

  describe('trusted launch flag', () => {
    it('is not armed by default - an external goal never auto-submits', () => {
      expect(consumeTrustedQuestLaunch()).toBe(false);
    });

    it('is armed by an in-app launch and consumed once', () => {
      armTrustedQuestLaunch();
      expect(consumeTrustedQuestLaunch()).toBe(true);
      // Consume-once: a second /new visit (e.g. a post-login replay) reads false.
      expect(consumeTrustedQuestLaunch()).toBe(false);
    });
  });
});
