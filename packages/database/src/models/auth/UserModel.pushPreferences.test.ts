import { describe, expect, it } from 'vitest';
import { User } from './UserModel';

describe('push notification preferences', () => {
  it('retains an explicit session handoff opt-out', () => {
    const user = new User({ preferences: { pushNotifications: { session_handoff: false } } });
    expect(user.toObject().preferences?.pushNotifications?.session_handoff).toBe(false);
  });
});
