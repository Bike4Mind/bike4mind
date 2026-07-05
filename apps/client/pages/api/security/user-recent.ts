import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { authFailLogRepository } from '@bike4mind/database';

/**
 * GET /api/security/user-recent
 * Returns recent user-specific security events (failed logins + suspicious patterns targeting user)
 * Query params:
 *  - limit: number of records (default 5, max 50)
 *  - hours: lookback window in hours (default 24)
 */
const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { limit?: string; hours?: string }>(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '5', 10), 50); // cap at 50
    const hours = Math.min(parseInt(req.query.hours || '24', 10), 168); // cap at 7 days
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const user = req.user;
    if (!user || !user.email || !user.username) {
      return res.status(401).json({ error: 'User not authenticated or missing required fields' });
    }

    // Only expose usernames belonging to the current user to avoid leaking
    // other users' identifiers that were targeted from the same IP
    const userIdentifiers = new Set([user.username.toLowerCase(), user.email.toLowerCase()]);

    const userFailedLogins = await authFailLogRepository.getUserFailedLogins(user.email, user.username, since);

    // Checks suspicious patterns for this user; the function also checks email internally
    const suspiciousPatterns = await authFailLogRepository.getSuspiciousPatternsTargetingUser(user.username, since);

    const allEvents = [
      ...userFailedLogins.map(login => ({
        type: 'failed_login',
        data: login,
        timestamp: login.createdAt,
      })),
      ...suspiciousPatterns.map(pattern => ({
        type: 'suspicious_pattern',
        // Filter usernames to only those belonging to the current user
        data: {
          ...pattern,
          usernames: Array.isArray(pattern.usernames)
            ? pattern.usernames.filter(
                u => typeof u === 'string' && u.length > 0 && userIdentifiers.has(u.toLowerCase())
              )
            : [],
        },
        // Ensure we have a valid ISO timestamp
        timestamp:
          pattern?.lastAttempt && !isNaN(new Date(pattern.lastAttempt as unknown as string).getTime())
            ? pattern.lastAttempt
            : new Date().toISOString(),
      })),
    ]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    const recentEvents = allEvents;

    res.status(200).json({
      items: recentEvents,
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
