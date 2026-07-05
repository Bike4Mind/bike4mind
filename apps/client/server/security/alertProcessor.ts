import { authFailLogRepository, connectDB, userRepository } from '@bike4mind/database';
import type { ISuspiciousPattern } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { contextToLogs } from '@server/utils/logger';
import { Context } from 'aws-lambda';
import { Resource } from 'sst';
import { EmailEvents } from '@server/utils/eventBus';

interface IUserData {
  username: string;
  email: string;
}

/**
 * Format security alert message for email (HTML format)
 */
const formatSecurityAlert = (pattern: ISuspiciousPattern, username: string, userEmail: string): string => {
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
      <p>Dear ${username},</p>
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
          <span class="label">IP Address:</span> <span class="value">${ipAddress}</span>
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
          <span class="label">Strategies Used:</span> <span class="value">${pattern.strategies.join(', ')}</span>
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
const getUserDataFromUsernames = async (usernames: string[]): Promise<IUserData[]> => {
  try {
    console.log(`Fetching user data for usernames: ${JSON.stringify(usernames)}`);

    const users = await userRepository.findAllByEmailsOrUsernames([], usernames);
    console.log(`Found ${users.length} users via findAllByEmailsOrUsernames`);

    // If no users found, try individual lookups
    if (users.length === 0) {
      console.log('No users found via findAllByEmailsOrUsernames, trying individual lookups...');
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
            console.log(`Found user: ${user.username} (${user.email})`);
          }
        } catch (error) {
          console.log(`Failed to find user for identifier: ${username}`, error);
        }
      }

      return individualUsers.map(user => ({
        username: user.username,
        email: user.email || '',
      }));
    }

    return users.map(user => ({
      username: user.username,
      email: user.email || '',
    }));
  } catch (error) {
    console.error('Error fetching user data:', error);
    return [];
  }
};

/**
 * Get suspicious patterns for alerts (last 5 minutes)
 */
const getSuspiciousPatternsForAlerts = async (): Promise<ISuspiciousPattern[]> => {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000);

    // Use repository method instead of direct aggregation
    const allPatterns = await authFailLogRepository.getSuspiciousPatternsForAlerts(since);

    return allPatterns;
  } catch (error) {
    console.error('Error fetching suspicious patterns:', error);
    return [];
  }
};

/**
 * Lambda handler for processing security alerts
 * Triggered by CloudWatch Events schedule (every 5 minutes)
 */
export const handler = async (event: unknown, context: Context) => {
  try {
    const logger = new Logger().withMetadata(contextToLogs(context));
    await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), logger);
    console.log('Security alert processor triggered:', JSON.stringify(event, null, 2));

    const suspiciousPatterns = await getSuspiciousPatternsForAlerts();
    console.log(`Found ${suspiciousPatterns.length} suspicious patterns`);

    let alertsSent = 0;

    for (const pattern of suspiciousPatterns) {
      const ipAddress = pattern.ip || (typeof pattern._id === 'object' ? pattern._id.ip : pattern._id) || 'Unknown IP';
      console.log(
        `Processing pattern: IP=${ipAddress}, Attempts=${pattern.attempts}, Usernames=${pattern.usernames.length}`
      );

      const userData = await getUserDataFromUsernames(pattern.usernames);
      console.log(`Found ${userData.length} users for pattern`);

      for (const user of userData) {
        if (!user.email || !user.email.includes('@')) {
          console.log(`Skipping user ${user.username} - invalid email: ${user.email}`);
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

          console.log(`Alert sent to ${user.username} (${user.email})`);
          alertsSent++;
        } catch (error) {
          console.error(`Failed to send alert to ${user.username}:`, error);
          logger.error('Failed to send security alert email', {
            username: user.username,
            email: user.email,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    console.log(`Security alert processing completed. ${alertsSent} alerts sent.`);

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
    console.error('Error in security alert processor:', error);

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
