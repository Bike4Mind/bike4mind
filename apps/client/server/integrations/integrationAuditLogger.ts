import {
  integrationAuditLogRepository,
  IntegrationAuditEntityType,
  IntegrationAuditIntegrationName,
  IntegrationAuditOutcome,
  CreateIntegrationAuditLogInput,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import type { Request } from 'express';
import type { NextApiRequest } from 'next';
import { getClientIp } from '@server/utils/ip';

/**
 * Fields to redact from metadata for security (tokens, secrets, etc.)
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
  'client_secret',
  'webhook_secret',
  'private_key',
  'credential',
  'signing_key',
  'passphrase',
];

/**
 * Context for creating an integration audit log entry
 */
export interface IntegrationAuditContext {
  entityType: IntegrationAuditEntityType;
  integrationName: IntegrationAuditIntegrationName;
  action: string;
  requestId: string;
  userId?: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

interface MinimalLogger {
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * IntegrationAuditLogger provides async, non-blocking audit logging
 * for integration operations (OAuth, webhooks, token refresh).
 *
 * Follows the same pattern as SlackAuditLogger:
 * - Fire-and-forget logging (doesn't block request handling)
 * - Sensitive data redaction
 * - Duration tracking
 * - Error capture
 */
export class IntegrationAuditLogger {
  private logger: MinimalLogger;
  private startTime: number;
  private context: IntegrationAuditContext;
  private sourceIp: string;
  private userAgent: string;
  private logged = false;

  constructor(context: IntegrationAuditContext, req?: Request | NextApiRequest, logger?: MinimalLogger) {
    this.context = context;
    this.startTime = Date.now();
    this.logger = logger || Logger;
    this.sourceIp = req ? extractIp(req) : 'unknown';
    this.userAgent = req ? extractUserAgent(req) : 'unknown';
  }

  /**
   * Create a new audit logger for an integration operation
   */
  static create(
    context: IntegrationAuditContext,
    req?: Request | NextApiRequest,
    logger?: MinimalLogger
  ): IntegrationAuditLogger {
    return new IntegrationAuditLogger(context, req, logger);
  }

  /**
   * Set the user ID (useful when user is resolved after logger creation)
   */
  setUserId(userId: string): void {
    this.context.userId = userId;
  }

  /**
   * Set the workspace ID
   */
  setWorkspaceId(workspaceId: string): void {
    this.context.workspaceId = workspaceId;
  }

  /**
   * Log a successful operation (fire-and-forget)
   */
  success(additionalMetadata?: Record<string, unknown>): void {
    this.log('success', undefined, additionalMetadata);
  }

  /**
   * Log a failed operation (fire-and-forget)
   */
  failure(errorCode: string, additionalMetadata?: Record<string, unknown>): void {
    this.log('failure', errorCode, additionalMetadata);
  }

  /**
   * Log a rate-limited operation (fire-and-forget)
   */
  rateLimited(additionalMetadata?: Record<string, unknown>): void {
    this.log('rate_limited', 'rate_limited', additionalMetadata);
  }

  /**
   * Internal logging method - async but fire-and-forget
   */
  private log(
    outcome: IntegrationAuditOutcome,
    errorCode?: string,
    additionalMetadata?: Record<string, unknown>
  ): void {
    if (this.logged) {
      this.logger.error('[IntegrationAuditLogger] Attempted to log twice for same request', {
        context: {
          entityType: this.context.entityType,
          action: this.context.action,
          requestId: this.context.requestId,
          attemptedOutcome: outcome,
        },
      });
      return;
    }
    this.logged = true;

    const durationMs = Date.now() - this.startTime;

    const metadata = redactSensitiveData({
      ...this.context.metadata,
      ...additionalMetadata,
    });

    const logData: CreateIntegrationAuditLogInput = {
      entityType: this.context.entityType,
      integrationName: this.context.integrationName,
      action: this.context.action,
      userId: this.context.userId,
      workspaceId: this.context.workspaceId,
      requestId: this.context.requestId,
      sourceIp: this.sourceIp,
      userAgent: this.userAgent,
      outcome,
      errorCode,
      durationMs,
      metadata,
    };

    // Fire-and-forget: don't await, catch errors silently
    integrationAuditLogRepository.createLog(logData).catch(err => {
      this.logger.error('[IntegrationAuditLogger] Failed to write audit log', {
        error: err,
        context: {
          entityType: this.context.entityType,
          integrationName: this.context.integrationName,
          action: this.context.action,
        },
      });
    });
  }
}

/**
 * Redact sensitive fields from metadata
 */
function redactSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field.toLowerCase()))) {
      redacted[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      redacted[key] = value.map(item =>
        typeof item === 'object' && item !== null ? redactSensitiveData(item as Record<string, unknown>) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Extract client IP address from request.
 * Delegates to the shared getClientIp resolver, which walks the canonical CDN
 * headers in priority order and filters private/reserved ranges. This avoids
 * trusting the raw, spoofable leftmost x-forwarded-for value in audit records.
 * Cast is required because getClientIp is typed for express Request,
 * while audit logging also accepts NextApiRequest - both expose the headers /
 * socket / ip fields the resolver reads.
 */
function extractIp(req: Request | NextApiRequest): string {
  // any: getClientIp is typed for express Request; NextApiRequest is structurally
  // compatible for the fields it reads (headers, socket, ip) but not assignable.
  return getClientIp(req as any);
}

/**
 * Extract user agent from request headers
 */
function extractUserAgent(req: Request | NextApiRequest): string {
  return req.headers?.['user-agent'] || 'unknown';
}
