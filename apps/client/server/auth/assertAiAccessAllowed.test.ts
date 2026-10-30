import { describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { assertAiAccessAllowed } from './assertAiAccessAllowed';

describe('assertAiAccessAllowed', () => {
  it('allows a user who is not moderated', () => {
    expect(() => assertAiAccessAllowed({ isModerated: false })).not.toThrow();
  });

  it('refuses a moderated user with a 403', () => {
    expect(() => assertAiAccessAllowed({ isModerated: true })).toThrow(ForbiddenError);
    expect(() => assertAiAccessAllowed({ isModerated: true })).toThrow('AI features are disabled');
  });

  it('fails closed when no user is attached', () => {
    expect(() => assertAiAccessAllowed(undefined)).toThrow(UnauthorizedError);
  });

  it('refuses pending signup reviews even without a manual restriction', () => {
    const user = { isModerated: false, riskScore: { reviewState: 'pending' as const } };
    expect(() => assertAiAccessAllowed(user)).toThrow(ForbiddenError);
    expect(() => assertAiAccessAllowed(user)).toThrow('awaits review');
  });

  it('allows approved accounts but keeps independent admin restrictions', () => {
    const riskScore = { reviewState: 'approved' as const };
    expect(() => assertAiAccessAllowed({ riskScore })).not.toThrow();
    expect(() => assertAiAccessAllowed({ riskScore, isModerated: true })).toThrow('AI features are disabled');
  });
});
