import { authFailLogRepository, connectDB, userRepository } from '@bike4mind/database';
import type { ISuspiciousPattern } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { contextToLogs } from '@bike4mind/server-utils/utils/logger';
import { Context } from 'aws-lambda';
import { Resource } from 'sst';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import { escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';

interface IUserData {
  id: string;
  username: string;
  email: string;
}

/**
 * Format security alert message for email (HTML format)
 */
export const formatSecurityAlert = (pattern: ISuspiciousPattern, username: string, userEmail: string): string => {
  // Extract IP address - handle both possible _id formats
  const ipAddress = pattern.ip || (typeof pattern._id === 'object' ? pattern._id.ip : pattern._id) || 'Unknown IP';
  const alertType = pattern.attempts >= 5 ? 'Multiple Failed Attempts' : 'Username Enumeration';
  const severityColor =
    pattern.riskLevel === 'high' ? '#ef5350' : pattern.riskLevel === 'medium' ? '#ffb74d' : '#48bb78';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #ef5350 0%, #c62828 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f7fafc; padding: 20px; border-radius: 0 0 8px 8px; }
    .alert-box { background: white; padding: 16px; border-left: 4px solid ${severityColor}; margin: 16px 0; border-radius: 4px; }
    .detail-row { padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
    .detail-row:last-child { border-bottom: none; }
    .label { font-weight: 600; color: #718096; }
    .value { color: #2d3748; }
    .actions { background: white; padding: 16px; margin: 16px 0; border-radius: 4px; }
    .footer { text-align: center; color: #718096; font-size: 12px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 24px;">🚨 SECURITY ALERT 🚨</h1>
    </div>
    <div class="content">
      <p>Dear ${escapeHtml(username)},</p>
      <p>We have detected suspicious login activity targeting your account.</p>
      
      <div class="alert-box">
        <h2 style="margin-top: 0; color: ${severityColor};">ALERT DETAILS</h2>
        <div class="detail-row">
          <span class="label">Type:</span> <span class="value">${alertType}</span>
        </div>
        <div class="detail-row">
          <span class="label">Severity:</span> <span class="value" style="color: ${severityColor}; font-weight: 600;">${pattern.riskLevel.toUpperCase()}</span>
        </div>
        <div class="detail-row">
          <span class="label">IP Address:</span> <span class="value">${escapeHtml(ipAddress)}</span>
        </div>
        <div class="detail-row">
          <span class="label">Attempts:</span> <span class="value">${pattern.attempts}</span>
        </div>
        <div class="detail-row">
          <span class="label">Time Window:</span> <span class="value">5 minutes</span>
        </div>
        <div class="detail-row">
          <span class="label">Detected At:</span> <span class="value">${new Date().toLocaleString()}</span>
        </div>
      </div>

      <div class="alert-box">
        <h3 style="margin-top: 0;">SUSPICIOUS ACTIVITY</h3>
        <div class="detail-row">
          <span class="label">Failed Login Attempts:</span> <span class="value">${pattern.attempts}</span>
        </div>
        <div class="detail-row">
          <span class="label">Usernames Targeted:</span> <span class="value">${pattern.usernames.length}</span>
        </div>
        <div class="detail-row">
          <span class="label">Strategies Used:</span> <span class="value">${escapeHtml(pattern.strategies.join(', '))}</span>
        </div>
        <div class="detail-row">
          <span class="label">Time Range:</span> <span class="value">${new Date(pattern.firstAttempt).toLocaleString()} to ${new Date(pattern.lastAttempt).toLocaleString()}</span>
        </div>
      </div>

      <div class="actions">
        <h3 style="margin-top: 0;">RECOMMENDED ACTIONS</h3>
        <ol style="padding-left: 20px;">
          <li>Review your recent login activity in your Security tab</li>
          <li>Change your password if you suspect unauthorized access</li>
          <li>Enable two-factor authentication (2FA) if available</li>
          <li>Contact support if you notice any unauthorized activity</li>
        </ol>
      </div>

      <p style="color: #718096; font-size: 14px;">
        This is an automated security alert. If you did not attempt to log in recently, please take immediate action to secure your account.
      </p>
    </div>
    <div class="footer">
      <p>Best regards,<br>Security Team</p>
    </div>
  </div>
</body>
</html>
  `;
};

/**
 * Get user data (username and email) from usernames
 */
const getUserDataFromUsernames = async (usernames: string[], logger: Logger): Promise<IUserData[]> => {
  try {
    logger.info('Fetching user data for suspicious login usernames', { usernameCount: usernames.length });

    const users = await userRepository.findAllByEmailsOrUsernames([], usernames);
    logger.info('Looked up users in bulk', { userCount: users.length });

    // If no users found, try individual lookups
    if (users.length === 0) {
      logger.info('No users found in bulk lookup, trying individual lookups', { usernameCount: usernames.length });
      const individualUsers = [];

      for (const username of usernames) {
        try {
          // Try to find by username or email
          let user = null;
          if (username.includes('@')) {
            user = await userRepository.findByEmail(username);
          } else {
            // findByUsernameOrEmail requires an email arg; pass empty string since we only have a username.
            user = await userRepository.findByUsernameOrEmail(username, '');
          }

          if (user) {
            individualUsers.push(user);
            logger.info('Found user by individual lookup', { userId: String(user.id) });
          }
        } catch (error) {
          logger.warn('Failed to find user by individual lookup', { error });
        }
      }

      return individualUsers.map(user => ({
        id: String(user.id),
        username: user.username,
        email: user.email || '',
      }));
    }

    return users.map(user => ({
      id: String(user.id),
      username: user.username,
      email: user.email || '',
    }));
  } catch (error) {
    logger.error('Error fetching user data', { error });
    return [];
  }
};

/**
 * Get suspicious patterns for alerts (last 5 minutes)
 */
const getSuspiciousPatternsForAlerts = async (logger: Logger): Promise<ISuspiciousPattern[]> => {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000);

    // Use repository method instead of direct aggregation
    const allPatterns = await authFailLogRepository.getSuspiciousPatternsForAlerts(since);

    return allPatterns;
  } catch (error) {
    logger.error('Error fetching suspicious patterns', { error });
    return [];
  }
};

/**
 * Lambda handler for processing security alerts
 * Triggered by CloudWatch Events schedule (every 5 minutes)
 */
export const handler = async (event: unknown, context: Context) => {
  const logger = new Logger().withMetadata(contextToLogs(context));
  try {
    await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), logger);
    const { id: eventId, time: eventTime } = (event ?? {}) as { id?: string; time?: string };
    logger.info('Security alert processor triggered', { eventId, eventTime });

    const suspiciousPatterns = await getSuspiciousPatternsForAlerts(logger);
    logger.info('Found suspicious patterns', { patternCount: suspiciousPatterns.length });

    let alertsSent = 0;

    for (const pattern of suspiciousPatterns) {
      const ipAddress = pattern.ip || (typeof pattern._id === 'object' ? pattern._id.ip : pattern._id) || 'Unknown IP';
      logger.info('Processing suspicious login pattern', {
        ip: ipAddress,
        attempts: pattern.attempts,
        usernameCount: pattern.usernames.length,
      });

      const userData = await getUserDataFromUsernames(pattern.usernames, logger);
      logger.info('Found users for pattern', { userCount: userData.length });

      for (const user of userData) {
        if (!user.email || !user.email.includes('@')) {
          logger.warn('Skipping user with invalid email', { userId: user.id });
          continue;
        }

        try {
          const alertMessage = formatSecurityAlert(pattern, user.username, user.email);

          // Use EventBridge email system (same as rest of codebase)
          await EmailEvents.Send.publish({
            to: user.email,
            subject: `🚨 Security Alert: Suspicious Login Detected`,
            body: alertMessage,
          });

          logger.info('Security alert sent', { userId: user.id });
          alertsSent++;
        } catch (error) {
          logger.error('Failed to send security alert email', { userId: user.id, error });
        }
      }
    }

    logger.info('Security alert processing completed', { alertsSent });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Security alerts processed successfully',
        suspiciousPatterns: suspiciousPatterns.length,
        alertsSent,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    logger.error('Error in security alert processor', { error });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to process security alerts',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      }),
    };
  }
};
