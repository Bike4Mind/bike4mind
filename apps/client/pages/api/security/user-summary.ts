import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { authFailLogRepository } from '@bike4mind/database';

/**
 * GET /api/security/user-summary
 * Returns user-specific security data including their failed logins and suspicious patterns targeting them
 * Query: hours?=24
 */
const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { hours?: string }>(async (req, res) => {
    const hours = Math.min(parseInt(req.query.hours || '24', 10), 168);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const user = req.user;
    if (!user || !user.email || !user.username) {
      return res.status(401).json({ error: 'User not authenticated or missing required fields' });
    }

    const userFailedLogins = await authFailLogRepository.getUserFailedLogins(user.email, user.username, since);

    // Checks suspicious patterns for this user; the function also checks email internally
    const suspiciousPatterns = await authFailLogRepository.getSuspiciousPatternsTargetingUser(user.username, since);

    // Only expose usernames belonging to the current user to avoid leaking
    // other users' identifiers that were targeted from the same IP
    const userIdentifiers = new Set([user.username.toLowerCase(), user.email.toLowerCase()]);

    res.status(200).json({
      userFailures: {
        total: userFailedLogins.length,
        items: userFailedLogins,
      },
      suspiciousPatterns: {
        total: suspiciousPatterns.length,
        // Normalize usernames and dates to avoid UI 'unknown' values
        items: suspiciousPatterns.map(p => ({
          ...p,
          usernames: Array.isArray(p.usernames)
            ? p.usernames.filter(u => typeof u === 'string' && u.length > 0 && userIdentifiers.has(u.toLowerCase()))
            : [],
          lastAttempt:
            p?.lastAttempt && !isNaN(new Date(p.lastAttempt as unknown as string).getTime())
              ? p.lastAttempt
              : new Date().toISOString(),
          firstAttempt:
            p?.firstAttempt && !isNaN(new Date(p.firstAttempt as unknown as string).getTime())
              ? p.firstAttempt
              : new Date().toISOString(),
          riskLevel: p?.riskLevel ?? 'unknown',
        })),
      },
      since,
      user: {
        email: user.email,
        username: user.username,
      },
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
