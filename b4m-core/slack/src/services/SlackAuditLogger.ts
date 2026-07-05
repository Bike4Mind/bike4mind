import { Logger } from '@bike4mind/observability';
import type { IncomingMessage } from 'http';
import { getSlackDb } from '../di/registry';

export type SlackAuditEventType = 'command' | 'interaction' | 'event' | 'api_call';

export type SlackAuditResourceType =
  | 'notebook'
  | 'message'
  | 'user'
  | 'workspace'
  | 'settings'
  | 'integration'
  | 'none';

interface ISlackAuditLogDocument {
  id: string;
  timestamp: Date;
  eventType: SlackAuditEventType;
  userId?: string;
  slackUserId: string;
  slackTeamId: string;
  action: string;
  resourceType: SlackAuditResourceType;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  success: boolean;
  errorMessage?: string;
  durationMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Context for creating an audit log entry
 */
export interface SlackAuditContext {
  eventType: SlackAuditEventType;
  slackUserId: string;
  slackTeamId: string;
  action: string;
  userId?: string; // B4M user ID (optional - user may not be linked)
  resourceType?: SlackAuditResourceType;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Fields to redact from metadata for security
 */
const SENSITIVE_FIELDS = [
  'token',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'api_key',
  'apiKey',
  'authorization',
  'cookie',
  'session',
];

/**
 * SlackAuditLogger provides async, non-blocking audit logging for Slack integration
 *
 * Features:
 * - Fire-and-forget logging (doesn't block request handling)
 * - Sensitive data redaction
 * - Duration tracking
 * - Error capture
 */
export class SlackAuditLogger {
  private logger: Logger;
  private startTime: number;
  private context: SlackAuditContext;

  constructor(context: SlackAuditContext, logger?: Logger) {
    this.context = context;
    this.startTime = Date.now();
    this.logger = logger || new Logger({ metadata: { component: 'SlackAuditLogger' } });
  }

  /**
   * Create a new audit logger for a request
   */
  static create(context: SlackAuditContext, logger?: Logger): SlackAuditLogger {
    return new SlackAuditLogger(context, logger);
  }

  /**
   * Set the B4M user ID (useful when user is resolved after logger creation)
   */
  setUserId(userId: string): void {
    this.context.userId = userId;
  }

  /**
   * Set the resource being accessed/modified
   */
  setResource(resourceType: SlackAuditResourceType, resourceId?: string): void {
    this.context.resourceType = resourceType;
    this.context.resourceId = resourceId;
  }

  /**
   * Log a successful operation (fire-and-forget)
   */
  success(additionalMetadata?: Record<string, unknown>): void {
    this.log(true, undefined, additionalMetadata);
  }

  /**
   * Log a failed operation (fire-and-forget)
   */
  failure(errorMessage: string, additionalMetadata?: Record<string, unknown>): void {
    this.log(false, errorMessage, additionalMetadata);
  }

  /**
   * Internal logging method - async but fire-and-forget
   */
  private log(success: boolean, errorMessage?: string, additionalMetadata?: Record<string, unknown>): void {
    const durationMs = Date.now() - this.startTime;

    // Merge and redact metadata
    const metadata = this.redactSensitiveData({
      ...this.context.metadata,
      ...additionalMetadata,
    });

    const logData: Partial<ISlackAuditLogDocument> = {
      timestamp: new Date(),
      eventType: this.context.eventType,
      userId: this.context.userId,
      slackUserId: this.context.slackUserId,
      slackTeamId: this.context.slackTeamId,
      action: this.context.action,
      resourceType: this.context.resourceType || 'none',
      resourceId: this.context.resourceId,
      metadata,
      ipAddress: this.context.ipAddress,
      success,
      errorMessage,
      durationMs,
    };

    // Fire-and-forget: don't await, catch errors silently
    const { slackAuditLogRepository } = getSlackDb();
    (slackAuditLogRepository as any).createLog(logData).catch((err: unknown) => {
      this.logger.error('[SlackAuditLogger] Failed to write audit log', {
        error: err,
        context: {
          eventType: this.context.eventType,
          action: this.context.action,
          slackUserId: this.context.slackUserId,
        },
      });
    });
  }

  /**
   * Redact sensitive fields from metadata
   */
  private redactSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();

      // Check if this is a sensitive field
      if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field.toLowerCase()))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Recursively redact nested objects
        redacted[key] = this.redactSensitiveData(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }
}

/**
 * Quick helper to create and immediately log a successful audit entry
 */
export function logSlackAudit(context: SlackAuditContext): void {
  SlackAuditLogger.create(context).success();
}

/**
 * Quick helper to create and immediately log a failed audit entry
 */
export function logSlackAuditFailure(context: SlackAuditContext, errorMessage: string): void {
  SlackAuditLogger.create(context).failure(errorMessage);
}

/**
 * Extract client IP address from request
 * Handles x-forwarded-for header (common with proxies/load balancers) and falls back to socket address
 */
export function getClientIp(req: IncomingMessage): string | undefined {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    // x-forwarded-for can be comma-separated list; first is the original client
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    return ips.split(',')[0].trim();
  }
  // Express adds `ip` as a convenience property; fall back to socket address
  return ('ip' in req ? (req as { ip?: string }).ip : undefined) || req.socket?.remoteAddress;
}
