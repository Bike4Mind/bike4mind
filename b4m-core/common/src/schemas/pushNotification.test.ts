import { describe, expect, it } from 'vitest';
import {
  InterruptionFeedbackSchema,
  PushNotificationEventSchema,
  isBlockEndPushHeld,
  isHeldDuringBusyBlock,
} from './pushNotification';

describe('isHeldDuringBusyBlock', () => {
  it('holds run results, which the block brief lists', () => {
    expect(isHeldDuringBusyBlock('agent_completed')).toBe(true);
    expect(isHeldDuringBusyBlock('agent_failed')).toBe(true);
  });

  it('does not hold agent_message, which writes no run the block brief could list', () => {
    expect(isHeldDuringBusyBlock('agent_message')).toBe(false);
  });
});

describe('isBlockEndPushHeld', () => {
  it('never holds without feedback, so the fixed rule applies', () => {
    expect(isBlockEndPushHeld(undefined, ['agent_completed'])).toBe(false);
    expect(isBlockEndPushHeld(null, ['agent_completed'])).toBe(false);
    expect(isBlockEndPushHeld({}, ['agent_completed'])).toBe(false);
  });

  it('does not hold a push that reports no categories', () => {
    expect(isBlockEndPushHeld({ agent_completed: true, agent_failed: true }, [])).toBe(false);
  });

  it('holds when every reported category is taught to stay quiet', () => {
    expect(isBlockEndPushHeld({ agent_completed: true }, ['agent_completed'])).toBe(true);
    expect(isBlockEndPushHeld({ agent_completed: true, agent_failed: true }, ['agent_completed', 'agent_failed'])).toBe(
      true
    );
  });

  it('delivers when any reported category is not taught', () => {
    expect(isBlockEndPushHeld({ agent_completed: true }, ['agent_completed', 'agent_failed'])).toBe(false);
    expect(isBlockEndPushHeld({ agent_failed: true }, ['agent_completed'])).toBe(false);
    expect(isBlockEndPushHeld({ agent_completed: false }, ['agent_completed'])).toBe(false);
  });

  it('delivers when the brief holds a decision or other content', () => {
    const quiet = { agent_completed: true, agent_failed: true };
    expect(isBlockEndPushHeld(quiet, ['agent_completed', 'approval_needed'])).toBe(false);
    expect(isBlockEndPushHeld(quiet, ['agent_completed', 'brief_ready'])).toBe(false);
  });
});

describe('InterruptionFeedbackSchema', () => {
  it('accepts per-category booleans and an empty patch', () => {
    expect(InterruptionFeedbackSchema.parse({ agent_completed: true, agent_failed: false })).toEqual({
      agent_completed: true,
      agent_failed: false,
    });
    expect(InterruptionFeedbackSchema.parse({})).toEqual({});
  });

  it('rejects a category that cannot be taught and a non-boolean value', () => {
    expect(InterruptionFeedbackSchema.safeParse({ approval_needed: true }).success).toBe(false);
    expect(InterruptionFeedbackSchema.safeParse({ agent_completed: 'yes' }).success).toBe(false);
  });
});

describe('PushNotificationEventSchema blockEndCategories', () => {
  const base = { userId: 'u1', category: 'brief_ready', title: 't', body: 'b', deepLink: 'b4m://briefs/1' };

  it('accepts known categories and leaves the field optional', () => {
    expect(PushNotificationEventSchema.safeParse(base).success).toBe(true);
    expect(
      PushNotificationEventSchema.safeParse({ ...base, blockEndCategories: ['agent_completed', 'approval_needed'] })
        .success
    ).toBe(true);
  });

  it('rejects an unknown category and an oversized list', () => {
    expect(PushNotificationEventSchema.safeParse({ ...base, blockEndCategories: ['meeting_ended'] }).success).toBe(
      false
    );
    expect(
      PushNotificationEventSchema.safeParse({ ...base, blockEndCategories: Array(9).fill('agent_completed') }).success
    ).toBe(false);
  });
});
