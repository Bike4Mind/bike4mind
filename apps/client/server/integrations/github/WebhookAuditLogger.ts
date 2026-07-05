import { webhookAuditLogRepository } from '@bike4mind/database';
import { IWebhookAuditLog, IWebhookAuditAction, IWebhookAuditMetadata, WebhookAuditStatus } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { v4 as uuidv4 } from 'uuid';

/**
 * Serialize an error for structured logging. Error properties (message, stack, name)
 * are non-enumerable, so JSON.stringify produces `{}`. This helper extracts them
 * into a plain object that serializes correctly in CloudWatch/Slack alerts.
 */
function serializeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    const parts = [err.message];
    if (code) parts.push(`code=${code}`);
    if (err.stack) parts.push(err.stack);
    return parts.join(' | ');
  }
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/**
 * Check if a MongoDB error is a duplicate key error (E11000) on the deliveryId index.
 * This occurs when GitHub re-delivers a webhook and the deliveryId already exists.
 * Scoped to the specific index to avoid silently swallowing constraint violations
 * on other unique indexes that may be added in the future.
 */
function isDuplicateDeliveryIdError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const mongoErr = err as { code: number; message?: string };
    return mongoErr.code === 11000 && (mongoErr.message?.includes('deliveryId') ?? false);
  }
  return false;
}

/**
 * Context for creating a webhook audit log entry.
 */
export interface WebhookAuditContext {
  /** GitHub delivery ID (X-GitHub-Delivery header) */
  deliveryId: string;
  /** GitHub event type (X-GitHub-Event header) */
  event: string;
  /** Repository full name (owner/repo) */
  repository: string;
  /** GitHub user who triggered the event */
  sender: string;
  /** Whether HMAC signature was verified */
  signatureVerified?: boolean;
  /** GitHub event metadata */
  metadata?: IWebhookAuditMetadata;
  /** Correlation ID for distributed tracing (auto-generated if not provided) */
  correlationId?: string;
  /** B4M organization ID (for org-level webhooks) */
  organizationId?: string;
  /** MCP server ID (for per-user webhooks) */
  mcpServerId?: string;
}

/**
 * Fields to redact from metadata for security.
 */
const SENSITIVE_FIELDS = [
  // Token patterns
  'token',
  'access_token',
  'refresh_token',
  'github_token',
  'user_token',
  'service_token',
  'bearer',
  // Secret patterns
  'secret',
  'webhook_secret',
  'client_secret',
  'private_key',
  // Auth patterns
  'password',
  'credentials',
  'credential',
  'authorization',
  'auth',
  'jwt',
  // Key patterns
  'api_key',
  'apiKey',
  'key',
  'client_id',
  // Signature headers
  'x-hub-signature',
  'x-hub-signature-256',
];

/**
 * WebhookAuditLogger provides async, non-blocking audit logging for GitHub webhooks.
 *
 * Features:
 * - Fire-and-forget logging (doesn't block request handling)
 * - Lifecycle tracking (received -> processing -> completed/failed)
 * - Duration tracking
 * - Action recording
 * - Sensitive data redaction
 * - Error capture with stack traces
 *
 * @example
 * ```typescript
 * // In webhook endpoint
 * const logger = WebhookAuditLogger.create({
 *   deliveryId: headers['x-github-delivery'],
 *   event: headers['x-github-event'],
 *   repository: payload.repository?.full_name,
 *   sender: payload.sender?.login,
 *   signatureVerified: true,
 *   metadata: { prNumber: payload.pull_request?.number },
 * });
 * logger.received();
 *
 * // In queue handler
 * logger.processing();
 *
 * // On completion
 * logger.addAction({ type: 'fan_out', status: 'success', details: { count: 5 } });
 * logger.completed();
 *
 * // On failure
 * logger.failed(error);
 * ```
 */
export class WebhookAuditLogger {
  private logger: Logger;
  private startTime: number;
  private context: WebhookAuditContext;
  private actions: IWebhookAuditAction[] = [];
  private currentStatus: WebhookAuditStatus = WebhookAuditStatus.Received;

  constructor(context: WebhookAuditContext, logger?: Logger) {
    this.context = {
      ...context,
      correlationId: context.correlationId || uuidv4(),
    };
    this.startTime = Date.now();
    this.logger = logger || new Logger({ metadata: { component: 'WebhookAuditLogger' } });
  }

  /**
   * Create a new audit logger for a webhook request.
   */
  static create(context: WebhookAuditContext, logger?: Logger): WebhookAuditLogger {
    return new WebhookAuditLogger(context, logger);
  }

  /**
   * Get the correlation ID for this webhook.
   */
  get correlationId(): string {
    return this.context.correlationId!;
  }

  /**
   * Get the delivery ID for this webhook.
   */
  get deliveryId(): string {
    return this.context.deliveryId;
  }

  /**
   * Set the organization ID (useful when resolved after logger creation).
   */
  setOrganizationId(organizationId: string): void {
    this.context.organizationId = organizationId;
  }

  /**
   * Set the MCP server ID (useful when resolved after logger creation).
   */
  setMcpServerId(mcpServerId: string): void {
    this.context.mcpServerId = mcpServerId;
  }

  /**
   * Add an action to the audit log.
   */
  addAction(action: IWebhookAuditAction): void {
    this.actions.push({
      ...action,
      details: action.details ? this.redactSensitiveData(action.details) : undefined,
    });
  }

  /**
   * Log webhook received status (fire-and-forget).
   * Call this when the webhook is first received and validated.
   */
  received(): void {
    this.currentStatus = WebhookAuditStatus.Received;
    this.createAuditLog();
  }

  /**
   * Update to processing status (fire-and-forget).
   * Call this when processing begins in the queue handler.
   */
  processing(): void {
    this.currentStatus = WebhookAuditStatus.Processing;
    this.updateAuditLog({ status: WebhookAuditStatus.Processing });
  }

  /**
   * Log successful completion (fire-and-forget).
   * Call this when processing completes successfully.
   */
  completed(additionalActions?: IWebhookAuditAction[]): void {
    if (additionalActions) {
      additionalActions.forEach(action => this.addAction(action));
    }

    this.currentStatus = WebhookAuditStatus.Completed;
    this.updateAuditLog({
      status: WebhookAuditStatus.Completed,
      processedAt: new Date(),
      processingDurationMs: Date.now() - this.startTime,
      actions: this.actions,
    });
  }

  /**
   * Log failed processing (fire-and-forget).
   * Call this when processing fails with an error.
   */
  failed(error: Error, additionalActions?: IWebhookAuditAction[]): void {
    if (additionalActions) {
      additionalActions.forEach(action => this.addAction(action));
    }

    this.currentStatus = WebhookAuditStatus.Failed;
    this.updateAuditLog({
      status: WebhookAuditStatus.Failed,
      processedAt: new Date(),
      processingDurationMs: Date.now() - this.startTime,
      actions: this.actions,
      error: {
        message: error.message,
        // Note: Stack traces intentionally excluded from database for security
        code: (error as Error & { code?: string }).code,
      },
    });
  }

  /**
   * Create the initial audit log entry.
   */
  private createAuditLog(): void {
    const logData: Partial<IWebhookAuditLog> = {
      deliveryId: this.context.deliveryId,
      correlationId: this.context.correlationId!,
      event: this.context.event,
      repository: this.context.repository,
      sender: this.context.sender,
      organizationId: this.context.organizationId,
      mcpServerId: this.context.mcpServerId,
      receivedAt: new Date(),
      status: this.currentStatus,
      signatureVerified: this.context.signatureVerified ?? false,
      metadata: this.context.metadata || {},
      actions: [],
    };

    // Fire-and-forget: don't await, catch errors silently
    webhookAuditLogRepository.createLog(logData).catch(err => {
      // E11000 duplicate key = GitHub re-delivered this webhook; already logged, treat as no-op
      if (isDuplicateDeliveryIdError(err)) {
        this.logger.info('[WebhookAuditLogger] Duplicate deliveryId, skipping audit log creation', {
          deliveryId: this.context.deliveryId,
          event: this.context.event,
        });
        return;
      }

      this.logger.error('[WebhookAuditLogger] Failed to create audit log', {
        error: serializeError(err),
        deliveryId: this.context.deliveryId,
        event: this.context.event,
        repository: this.context.repository,
      });
    });
  }

  /**
   * Update an existing audit log entry.
   */
  private updateAuditLog(update: Partial<IWebhookAuditLog>): void {
    // Fire-and-forget: don't await, catch errors silently
    webhookAuditLogRepository.updateByDeliveryId(this.context.deliveryId, update).catch(err => {
      this.logger.error('[WebhookAuditLogger] Failed to update audit log', {
        error: serializeError(err),
        deliveryId: this.context.deliveryId,
        event: this.context.event,
        status: update.status,
      });
    });
  }

  /**
   * Redact sensitive fields from metadata.
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
 * Generate a correlation ID for distributed tracing.
 */
export function generateCorrelationId(): string {
  return uuidv4();
}

/**
 * Extract metadata from a GitHub webhook payload.
 * Extracts key fields for audit logging without storing full payload.
 */
export function extractWebhookMetadata(payload: Record<string, unknown>): IWebhookAuditMetadata {
  const metadata: IWebhookAuditMetadata = {};

  // PR number
  if (payload.pull_request && typeof payload.pull_request === 'object') {
    const pr = payload.pull_request as Record<string, unknown>;
    if (typeof pr.number === 'number') {
      metadata.prNumber = pr.number;
    }
  }

  // Issue number
  if (payload.issue && typeof payload.issue === 'object') {
    const issue = payload.issue as Record<string, unknown>;
    if (typeof issue.number === 'number') {
      metadata.issueNumber = issue.number;
    }
  }

  // Action (opened, closed, synchronize, etc.)
  if (typeof payload.action === 'string') {
    metadata.action = payload.action;
  }

  // Branch (for push events)
  if (typeof payload.ref === 'string') {
    // Extract branch name from refs/heads/branch-name
    metadata.branch = payload.ref.replace('refs/heads/', '');
  }

  // Commit count (for push events)
  if (Array.isArray(payload.commits)) {
    metadata.commitCount = payload.commits.length;
  }

  return metadata;
}

/**
 * Quick helper to create a logger and immediately log received status.
 */
export function logWebhookReceived(context: WebhookAuditContext): WebhookAuditLogger {
  const logger = WebhookAuditLogger.create(context);
  logger.received();
  return logger;
}

/**
 * Quick helper to update a webhook audit log to completed status.
 * This is for cases where you only have the deliveryId (e.g., in queue handlers).
 */
export function logWebhookCompleted(deliveryId: string, durationMs: number, actions?: IWebhookAuditAction[]): void {
  webhookAuditLogRepository
    .updateByDeliveryId(deliveryId, {
      status: WebhookAuditStatus.Completed,
      processedAt: new Date(),
      processingDurationMs: durationMs,
      actions: actions || [],
    })
    .catch(err => {
      const logger = new Logger({ metadata: { component: 'WebhookAuditLogger' } });
      logger.error('[WebhookAuditLogger] Failed to log webhook completed', {
        error: serializeError(err),
        deliveryId,
      });
    });
}

/**
 * Quick helper to update a webhook audit log to failed status.
 * This is for cases where you only have the deliveryId (e.g., in queue handlers).
 */
export function logWebhookFailed(
  deliveryId: string,
  error: Error,
  durationMs: number,
  actions?: IWebhookAuditAction[]
): void {
  webhookAuditLogRepository
    .updateByDeliveryId(deliveryId, {
      status: WebhookAuditStatus.Failed,
      processedAt: new Date(),
      processingDurationMs: durationMs,
      actions: actions || [],
      error: {
        message: error.message,
        // Note: Stack traces intentionally excluded from database for security
        code: (error as Error & { code?: string }).code,
      },
    })
    .catch(err => {
      const logger = new Logger({ metadata: { component: 'WebhookAuditLogger' } });
      logger.error('[WebhookAuditLogger] Failed to log webhook failed', {
        error: serializeError(err),
        deliveryId,
      });
    });
}
