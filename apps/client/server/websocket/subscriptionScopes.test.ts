import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { questMasterPlanSubscriptionScope } from './subscriptionScopes';

describe('questMasterPlanSubscriptionScope', () => {
  const userId = new Types.ObjectId().toString();
  const sessionIds = [new Types.ObjectId(), new Types.ObjectId()];

  it('includes owner, shared, public, and session arms', () => {
    const scope = questMasterPlanSubscriptionScope(userId, sessionIds);

    expect(scope.$or).toEqual([
      { userId },
      { sharedWith: userId },
      { visibility: 'public' },
      { notebookId: { $in: sessionIds } },
    ]);
  });

  it('matches a plan owned by the user', () => {
    const scope = questMasterPlanSubscriptionScope(userId, []);

    expect(scope.$or).toContainEqual({ userId });
  });

  it('matches a plan shared with the user regardless of session access', () => {
    const scope = questMasterPlanSubscriptionScope(userId, []);

    expect(scope.$or).toContainEqual({ sharedWith: userId });
    // No session access required for the shared arm
    expect(scope.$or).toContainEqual({ notebookId: { $in: [] } });
  });

  it('keeps the session-based arm for legacy plans', () => {
    const scope = questMasterPlanSubscriptionScope(userId, sessionIds);

    expect(scope.$or).toContainEqual({ notebookId: { $in: sessionIds } });
  });

  it('does not widen the userId arms beyond the requesting user', () => {
    const otherUser = new Types.ObjectId().toString();
    const scope = questMasterPlanSubscriptionScope(userId, sessionIds);

    expect(scope.$or).not.toContainEqual({ userId: otherUser });
    expect(scope.$or).not.toContainEqual({ sharedWith: otherUser });
  });
});
