import { IMongoDocument } from '@bike4mind/common';
import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

// Schema to store authentication failures independently from CounterLog
// Minimal and query-friendly; enrich as needed

export interface IAuthFailLogDocument extends IMongoDocument {
  email?: string;
  username?: string;
  strategy?: string;
  ip: string;
  userAgent?: string;
  reason?: string;
  requestId?: string;
  headers?: Record<string, unknown>;
  geo?: Record<string, unknown>;
  device?: Record<string, unknown>;
  mfa?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface ISuspiciousSummaryResult {
  suspiciousIPs: number;
}

export interface ISuspiciousPattern {
  _id: string | { ip: string; timeBucket: Date };
  ip?: string;
  timeBucket?: Date;
  attempts: number;
  usernames: string[];
  emails?: string[]; // Emails collected from failed login attempts
  strategies: string[];
  reasons: string[];
  lastAttempt: Date;
  firstAttempt: Date;
  riskLevel: string;
}

export interface IIPsWithHighAttempts {
  ip: string;
  attempts: number;
}

/**
 * @todo This is a temporary collection as CounterLog model currently can't be used for
 * unauthenticated users. This should be removed once we have a way to track unauthenticated
 * user activity.
 */
const AuthFailLogSchema = new mongoose.Schema(
  {
    ip: { type: String },
    email: { type: String },
    username: { type: String },
    strategy: { type: String }, // local | google | github | saml | okta
    userAgent: { type: String },
    reason: { type: String },
    requestId: { type: String },
    headers: { type: mongoose.Schema.Types.Mixed },
    geo: { type: mongoose.Schema.Types.Mixed },
    device: { type: mongoose.Schema.Types.Mixed },
    mfa: { type: mongoose.Schema.Types.Mixed },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for efficient suspicious login detection
AuthFailLogSchema.index({ createdAt: -1, ip: 1 }); // Time-based queries with IP grouping

const AuthFailLog: mongoose.Model<IAuthFailLogDocument> =
  mongoose.models.AuthFailLog || mongoose.model<IAuthFailLogDocument>('AuthFailLog', AuthFailLogSchema);

class AuthFailLogRepository extends BaseRepository<IAuthFailLogDocument> {
  constructor(model: mongoose.Model<IAuthFailLogDocument>) {
    super(model);
  }

  async countDocuments(filter: Record<string, unknown>) {
    return this.model.countDocuments(filter);
  }

  async findRecentByCreatedAtGte(limit: number, since: Date) {
    return this.model
      .find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  async getTotalSuspiciousIPsCount(since: Date): Promise<number> {
    const result = await this.model.aggregate<ISuspiciousSummaryResult>([
      // Match documents within time range (uses index)
      { $match: { createdAt: { $gte: since } } },
      // Group by IP and collect only necessary data
      {
        $group: {
          _id: '$ip',
          attempts: { $sum: 1 },
          uniqueUsernames: { $addToSet: '$username' },
        },
      },
      // Add computed field for unique username count
      {
        $addFields: {
          usernameCount: { $size: '$uniqueUsernames' },
        },
      },
      // Filter suspicious IPs (3+ attempts OR 2+ different usernames) - same criteria as Recent Activity
      {
        $match: {
          $or: [{ attempts: { $gte: 3 } }, { usernameCount: { $gte: 2 } }],
        },
      },
      // Count total suspicious IPs
      { $count: 'suspiciousIPs' },
    ]);
    return result.length > 0 ? result[0].suspiciousIPs : 0;
  }

  /**
   * Get suspicious login patterns grouped by IP address
   * A pattern is considered suspicious if:
   * - 3+ failed attempts from the same IP, OR
   * - 2+ different usernames attempted from the same IP
   */
  async getSuspiciousPatterns(since: Date, limit: number): Promise<ISuspiciousPattern[]> {
    const result = await this.model.aggregate<ISuspiciousPattern>([
      // Match documents within time range (uses index)
      { $match: { createdAt: { $gte: since } } },
      // Create 5-minute buckets and group by IP + bucket
      {
        $addFields: {
          fiveMinBucket: { $dateTrunc: { date: '$createdAt', unit: 'minute', binSize: 5 } },
        },
      },
      {
        $group: {
          _id: { ip: '$ip', bucket: '$fiveMinBucket' },
          ip: { $first: '$ip' },
          attempts: { $sum: 1 },
          strategies: { $addToSet: '$strategy' },
          usernames: { $addToSet: '$username' },
          reasons: { $addToSet: '$reason' },
          lastAttempt: { $max: '$createdAt' },
          firstAttempt: { $min: '$createdAt' },
        },
      },
      // Add computed field for username count
      {
        $addFields: {
          usernameCount: { $size: '$usernames' },
        },
      },
      // Filter for suspicious patterns
      {
        $match: {
          $or: [
            { attempts: { $gte: 3 } }, // 3+ attempts from same IP
            { usernameCount: { $gte: 2 } }, // 2+ different usernames from same IP
          ],
        },
      },
      // Sort by most recent activity first
      { $sort: { lastAttempt: -1 } },
      // Limit results
      { $limit: limit },
    ]);
    return result;
  }

  /**
   * Get failed login attempts for a specific user
   */
  async getUserFailedLogins(userEmail: string, username: string, since: Date): Promise<IAuthFailLogDocument[]> {
    return this.model
      .find({
        $or: [{ email: userEmail }, { username: username }],
        createdAt: { $gte: since },
      })
      .sort({ createdAt: -1 });
  }

  /**
   * Get IPs with high number of failed attempts (>=10) within a time window
   * Used for auto-blocking IPs with excessive failed login attempts
   */
  async getIPsWithHighAttempts(since: Date, minAttempts: number = 10): Promise<IIPsWithHighAttempts[]> {
    const result = await this.model.aggregate<IIPsWithHighAttempts>([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$ip', attempts: { $sum: 1 } } },
      { $match: { attempts: { $gte: minAttempts } } },
      { $project: { _id: 0, ip: '$_id', attempts: 1 } },
    ]);
    return result;
  }

  /**
   * Count failed login attempts for a specific IP within a time window
   * Used for auto-blocking evaluation during authentication
   */
  async countAttemptsForIP(ip: string, since: Date): Promise<number> {
    const result = await this.model.aggregate<{ attempts: number }>([
      { $match: { createdAt: { $gte: since }, ip } },
      { $group: { _id: '$ip', attempts: { $sum: 1 } } },
    ]);
    return result?.[0]?.attempts || 0;
  }

  /**
   * Get suspicious patterns for security alerts (higher thresholds)
   * Uses stricter criteria to reduce false positives:
   * - 5+ failed attempts from the same IP within 5 minutes, OR
   * - 3+ different usernames attempted from the same IP within 5 minutes
   */
  async getSuspiciousPatternsForAlerts(since: Date): Promise<ISuspiciousPattern[]> {
    const result = await this.model.aggregate<ISuspiciousPattern>([
      // Match documents within time range (uses index)
      { $match: { createdAt: { $gte: since } } },
      // Group by IP and 5-minute time buckets
      {
        $group: {
          _id: {
            ip: '$ip',
            timeBucket: {
              $dateTrunc: {
                date: '$createdAt',
                unit: 'minute',
                binSize: 5,
              },
            },
          },
          attempts: { $sum: 1 },
          strategies: { $addToSet: '$strategy' },
          usernames: { $addToSet: '$username' },
          reasons: { $addToSet: '$reason' },
          lastAttempt: { $max: '$createdAt' },
          firstAttempt: { $min: '$createdAt' },
        },
      },
      // Add computed fields
      {
        $addFields: {
          ip: '$_id.ip',
          timeBucket: '$_id.timeBucket',
          usernameCount: { $size: '$usernames' },
          riskLevel: {
            $cond: {
              if: { $gte: ['$attempts', 5] },
              then: 'high',
              else: {
                $cond: {
                  if: { $gte: ['$attempts', 3] },
                  then: 'medium',
                  else: 'low',
                },
              },
            },
          },
        },
      },
      // Filter for alert-worthy patterns (stricter thresholds)
      {
        $match: {
          $or: [
            { attempts: { $gte: 5 } }, // Multiple Failed Attempts
            { usernameCount: { $gte: 3 } }, // Username Enumeration
          ],
        },
      },
      // Sort by most recent activity first
      { $sort: { lastAttempt: -1 } },
    ]);
    return result;
  }

  /**
   * Get suspicious patterns targeting a specific user
   * Returns patterns where the user was one of the targets
   */
  async getSuspiciousPatternsTargetingUser(username: string, since: Date): Promise<ISuspiciousPattern[]> {
    const userFailedLogins = await this.model
      .find({
        $or: [
          { username: username },
          { email: username }, // In case username is actually an email
        ],
        createdAt: { $gte: since },
      })
      .limit(5);

    console.log(`Found ${userFailedLogins.length} failed logins for user: ${username}`);
    console.log('Sample failed login:', userFailedLogins[0]);

    const allPatterns = await this.model.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$ip',
          attempts: { $sum: 1 },
          usernames: { $addToSet: '$username' },
        },
      },
      {
        $addFields: {
          usernameCount: { $size: '$usernames' },
        },
      },
    ]);

    console.log(`All patterns found: ${allPatterns.length}`);
    allPatterns.forEach((pattern, index) => {
      console.log(
        `All Pattern ${index + 1}: IP=${pattern._id}, Attempts=${pattern.attempts}, Usernames=${JSON.stringify(pattern.usernames)}`
      );
    });

    const result = await this.model.aggregate<ISuspiciousPattern>([
      // Match documents within time range
      { $match: { createdAt: { $gte: since } } },
      // Group by IP and 5-minute time buckets
      {
        $group: {
          _id: {
            ip: '$ip',
            timeBucket: {
              $dateTrunc: {
                date: '$createdAt',
                unit: 'minute',
                binSize: 5, // 5-minute buckets
              },
            },
          },
          attempts: { $sum: 1 },
          strategies: { $addToSet: '$strategy' },
          usernames: { $addToSet: '$username' },
          emails: { $addToSet: '$email' }, // Also collect emails for matching
          reasons: { $addToSet: '$reason' },
          lastAttempt: { $max: '$createdAt' },
          firstAttempt: { $min: '$createdAt' },
        },
      },
      // Add computed fields for username count and risk level
      {
        $addFields: {
          ip: '$_id.ip', // Promote IP to top level
          timeBucket: '$_id.timeBucket', // Promote timeBucket
          usernameCount: { $size: '$usernames' },
          riskLevel: {
            $cond: {
              if: { $gte: ['$attempts', 5] },
              then: 'high',
              else: {
                $cond: {
                  if: { $gte: ['$attempts', 3] },
                  then: 'medium',
                  else: 'low',
                },
              },
            },
          },
        },
      },
      // Filter for suspicious patterns within each 5-minute bucket that include the target user
      {
        $match: {
          $and: [
            {
              $or: [
                { attempts: { $gte: 5 } }, // Multiple Failed Attempts within 5 minutes
                { usernameCount: { $gte: 3 } }, // Username Enumeration within 5 minutes
              ],
            },
            {
              $or: [
                { usernames: { $in: [username] } }, // Must include the target user's username
                { emails: { $in: [username] } }, // Or target user's email
              ],
            },
          ],
        },
      },
      // Sort by most recent activity first
      { $sort: { lastAttempt: -1 } },
    ]);

    console.log(`Found ${result.length} suspicious patterns for user: ${username}`);
    console.log('Sample suspicious pattern:', result[0]);

    console.log('Raw aggregation result:', JSON.stringify(result, null, 2));

    // Type guard helper for _id field
    const getIdValue = (
      id: string | { ip: string; timeBucket: Date },
      field: 'ip' | 'timeBucket'
    ): string | Date | undefined => {
      if (typeof id === 'object' && id !== null && 'ip' in id && 'timeBucket' in id) {
        return id[field];
      }
      return undefined;
    };

    result.forEach((pattern, index) => {
      console.log(`\n=== Pattern ${index + 1} Analysis ===`);
      console.log(`IP: ${pattern.ip || getIdValue(pattern._id, 'ip') || pattern._id}`);
      console.log(`Time Bucket: ${pattern.timeBucket || getIdValue(pattern._id, 'timeBucket')}`);
      console.log(`Total attempts: ${pattern.attempts}`);
      console.log(`Unique usernames: ${pattern.usernames?.length || 0}`);
      console.log(`Usernames: ${JSON.stringify(pattern.usernames)}`);
      console.log(
        `Includes target user (${username}): ${pattern.usernames?.includes(username) || pattern.emails?.includes(username)}`
      );

      // Check which criteria it meets (now properly enforced by time bucketing)
      const meetsMultipleAttempts = pattern.attempts >= 5;
      const meetsUsernameEnumeration = (pattern.usernames?.length || 0) >= 3;

      console.log(`Criteria met:`);
      console.log(
        `  - Multiple Failed Attempts (5+ within 5min): ${meetsMultipleAttempts} (${pattern.attempts} attempts)`
      );
      console.log(
        `  - Username Enumeration (3+ within 5min): ${meetsUsernameEnumeration} (${pattern.usernames?.length || 0} usernames)`
      );
      console.log(`  - Risk Level: ${pattern.riskLevel}`);
    });

    result.forEach((pattern, index) => {
      console.log(`Pattern ${index + 1}:`);
      console.log(`  - IP: ${pattern.ip || getIdValue(pattern._id, 'ip') || pattern._id}`);
      console.log(`  - Time Bucket: ${pattern.timeBucket || getIdValue(pattern._id, 'timeBucket')}`);
      console.log(`  - Attempts: ${pattern.attempts}`);
      console.log(`  - Usernames: ${JSON.stringify(pattern.usernames)}`);
      console.log(`  - Username Count: ${pattern.usernames?.length || 0}`);
      console.log(`  - Risk Level: ${pattern.riskLevel}`);
      console.log(
        `  - Includes target user: ${pattern.usernames?.includes(username) || pattern.emails?.includes(username)}`
      );
    });

    // Ensure dates are properly formatted and add debugging
    const formattedResult = result.map((pattern, index) => {
      console.log(`Formatting pattern ${index + 1}:`, {
        originalLastAttempt: pattern.lastAttempt,
        originalRiskLevel: pattern.riskLevel,
        originalAttempts: pattern.attempts,
        originalUsernames: pattern.usernames,
      });

      // Ensure we have valid dates
      const lastAttemptDate = pattern.lastAttempt ? new Date(pattern.lastAttempt) : new Date();
      const firstAttemptDate = pattern.firstAttempt ? new Date(pattern.firstAttempt) : new Date();

      // Validate dates
      const validLastAttempt = isNaN(lastAttemptDate.getTime()) ? new Date() : lastAttemptDate;
      const validFirstAttempt = isNaN(firstAttemptDate.getTime()) ? new Date() : firstAttemptDate;

      return {
        ...pattern,
        lastAttempt: validLastAttempt,
        firstAttempt: validFirstAttempt,
        riskLevel: pattern.riskLevel || 'unknown',
        attempts: pattern.attempts || 0,
        usernames: pattern.usernames || [],
      };
    });

    console.log('Final formatted result:', formattedResult);
    return formattedResult;
  }
}

export const authFailLogRepository = new AuthFailLogRepository(AuthFailLog);
