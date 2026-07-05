import { logEvent } from '@server/utils/analyticsLog';
import { AuthEvents } from '@bike4mind/common';
import { AdminConfigAuditEvents, AdminOrgAuditEvents, EmailAuditEvents } from '@server/utils/auditLogEvents';

// Re-export so existing call sites continue to import these names from `auditLog`.
// The canonical definitions live in `auditLogEvents.ts` to avoid an import cycle
// between this module and `analytics/index.ts` (which registers them in
// `ANALYTICS_EVENTS`).
export { AdminConfigAuditEvents, AdminOrgAuditEvents, EmailAuditEvents };

export interface AuditLogMetadata {
  userId: string;
  action: EmailAuditEvents | AuthEvents | AdminConfigAuditEvents | AdminOrgAuditEvents;
  ip?: string;
  userAgent?: string;
  oldEmail?: string;
  newEmail?: string;
  tokenAge?: number; // milliseconds since token was generated
  adminUserId?: string;
  adminUsername?: string;
  reason?: string;
  error?: string;
  // Configuration change fields
  configType?: string; // e.g., 'whats-new-config'
  oldConfig?: Record<string, unknown>; // Previous configuration state
  newConfig?: Record<string, unknown>; // New configuration state
  changedFields?: string[]; // List of fields that changed
  // Generic metadata for additional context
  metadata?: Record<string, unknown>;
}

/**
 * Minimal logger shape this module needs. Compatible with @bike4mind/observability
 * `ILogger`, but declared locally to keep this util free of import-cycle risk.
 */
interface AuditLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * Log an audit event.
 *
 * Wraps the analytics logEvent system to provide structured audit logging
 * for security-relevant operations (email verification, admin actions,
 * configuration changes, etc.).
 *
 * @param metadata - Audit log metadata including user ID, action, and contextual information
 * @param logger - Optional logger for additional console logging (from request context)
 */
export async function logAuditEvent(metadata: AuditLogMetadata, logger?: AuditLogger): Promise<void> {
  const { userId, action, ...rest } = metadata;

  try {
    // any: AnalyticsEventPayloads is a discriminated union keyed by *literal*
    // `type` values. `action` is the broader enum union, which TypeScript
    // can't narrow without per-event discrimination across ~25 payload
    // variants - out of scope here. The runtime registration in ANALYTICS_EVENTS
    // guarantees validity. Fixing upstream needs a payload-type plumbing pass.

    await logEvent({
      userId,
      type: action as any,
      metadata: {
        ...rest,
        timestamp: new Date().toISOString(),
      },
    });

    if (logger) {
      const logMessage = `[AUDIT] ${action} - User: ${userId}`;
      const logDetails = Object.entries(rest)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');

      logger.info(logMessage, logDetails);
    }
  } catch (error) {
    // Never fail the operation due to logging errors, but log at ERROR level
    // (not warn) - a missing audit event is a SOC2/compliance gap, and the
    // monitoring rule for this codebase only pages on error-level entries.
    //
    // Call methods directly (not via extracted refs) so `this` stays bound
    // to the Logger instance - `Logger.error` reads `this.shouldLog(...)`
    // internally and crashes if invoked unbound.
    const payload = { action, userId, error };
    if (logger) {
      logger.error('Failed to log audit event', payload);
    } else {
      console.error('Failed to log audit event', payload);
    }
  }
}

export function calculateTokenAge(sentAt: Date): number {
  return Date.now() - sentAt.getTime();
}

export function detectChangedFields(oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>): string[] {
  const changedFields: string[] = [];

  const allKeys = new Set([...Object.keys(oldConfig || {}), ...Object.keys(newConfig || {})]);

  for (const key of Array.from(allKeys)) {
    const oldValue = oldConfig?.[key];
    const newValue = newConfig?.[key];

    // Compare values (handles undefined, null, primitives, and objects)
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changedFields.push(key);
    }
  }

  return changedFields;
}
