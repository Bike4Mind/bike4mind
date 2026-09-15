import type { UserLevelType } from '@bike4mind/common';

interface UserTypeInput {
  level: UserLevelType;
  subscribedUntil: string | null;
}

// 'trial' is intentionally excluded - b4m has no backing trial signal.
// isSystem users are never passed here; Q4 middleware gates them out upstream.
export function resolveUserType(user: UserTypeInput): 'subscriber' | 'free' {
  if (user.level === 'DemoUser') return 'free';

  if (user.level === 'PaidUser') {
    if (!user.subscribedUntil) return 'free';
    const expiry = new Date(user.subscribedUntil);
    // Unparseable date or past expiry -> treat as free
    return !isNaN(expiry.getTime()) && expiry.getTime() > Date.now() ? 'subscriber' : 'free';
  }

  // VIPUser, ManagerUser, AdminUser - permanent access seats
  return 'subscriber';
}
