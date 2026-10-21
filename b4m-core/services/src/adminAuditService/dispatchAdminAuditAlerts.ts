import {
  ADMIN_AUDIT_CREDIT_GRANT_ACTIONS,
  adminAuditLogPath,
  type AdminAuditAlertState,
  type AdminAuditOpenBurst,
  type AuditActor,
  type AuditEntry,
  type AuditLogCursor,
  type IAdminAuditAlertStateRepository,
  type IAdminAuditLogRepository,
} from '@bike4mind/common';

/**
 * Entries younger than this are left for the next run. occurredAt is stamped before the writer's
 * transaction commits, so a slow transaction can surface an entry older than one already read;
 * waiting out Mongo's default 60s transaction lifetime keeps the cursor from skipping it.
 */
export const ALERT_SETTLE_MS = 60_000;
export const BURST_WINDOW_MS = 10 * 60_000;
/** More than this many grants by one actor inside BURST_WINDOW_MS is a burst. */
export const BURST_GRANT_LIMIT = 20;
const BATCH_LIMIT = 200;
// The smallest ObjectId: a cursor at (t, MIN_ENTRY_ID) puts every entry stamped at t still ahead of it.
const MIN_ENTRY_ID = '0'.repeat(24);

export type AdminAuditAlertAdapters = {
  db: {
    adminAuditLog: Pick<IAdminAuditLogRepository, 'listAscending' | 'countCreditGrants'>;
    alertState: IAdminAuditAlertStateRepository;
  };
  /** Empty means alerts are off. */
  webhookUrl: string;
  /** Resolves true only when Slack accepted the message. */
  postMessage: (webhookUrl: string, text: string) => Promise<boolean>;
  /** Turns an app path into an absolute URL, or null when the app URL is unknown. */
  toAppUrl: (path: string) => string | null;
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => Date;
};

export type AdminAuditAlertRunResult =
  | { status: 'initialized' }
  | { status: 'disabled' }
  | { status: 'ran'; scanned: number; alerted: number; blocked: boolean };

const escapeSlack = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatCredits = (credits: number) => credits.toLocaleString('en-US');

const describeActor = (actor: AuditActor): string => {
  const parts = [actor.email ? `${actor.name} (${actor.email})` : actor.name];
  if (actor.kind === 'apiKey') parts.push('via API key');
  if (actor.impersonatedUserId) parts.push(`while impersonating user ${actor.impersonatedUserId}`);
  return escapeSlack(parts.join(' '));
};

const describeTarget = ({ target }: AuditEntry) =>
  escapeSlack(
    target.displayName === target.id
      ? `${target.kind} ${target.id}`
      : `${target.kind} ${target.displayName} (${target.id})`
  );

const describeThreshold = (entry: AuditEntry): string | null => {
  const exceeded = entry.details?.grantThresholdExceeded;
  if (typeof exceeded !== 'object' || exceeded === null || !('kind' in exceeded) || !('limitCredits' in exceeded)) {
    return null;
  }
  if (typeof exceeded.limitCredits !== 'number') return null;
  const limit = formatCredits(exceeded.limitCredits);
  return exceeded.kind === 'dailyTotal'
    ? `Takes this admin past ${limit} credits granted in 24 hours`
    : `Above the ${limit}-credit single-grant threshold`;
};

const withLink = (lines: string[], url: string | null, label: string) =>
  [...lines, ...(url ? [`<${url}|${label}>`] : [])].join('\n');

export const formatCriticalAlert = (entry: AuditEntry, entryUrl: string | null): string => {
  const threshold = describeThreshold(entry);
  return withLink(
    [
      `:rotating_light: *Critical admin action:* ${describeActor(entry.actor)} ${escapeSlack(entry.summary)}`,
      `*Action:* ${entry.action}`,
      `*Target:* ${describeTarget(entry)}`,
      `*Reason:* ${entry.reason ? escapeSlack(entry.reason) : '_none given_'}`,
      ...(threshold ? [`*Threshold:* ${threshold}`] : []),
    ],
    entryUrl,
    'Open in the Audit Log'
  );
};

export const formatBurstAlert = (entry: AuditEntry, grantCount: number, actorUrl: string | null): string =>
  withLink(
    [
      `:warning: *Credit grant burst:* ${describeActor(entry.actor)} made ${grantCount} credit grants in ` +
        `${BURST_WINDOW_MS / 60_000} minutes (more than ${BURST_GRANT_LIMIT}). Further grants in this burst will not alert again.`,
      `*Latest:* ${escapeSlack(entry.summary)} to ${describeTarget(entry)}`,
    ],
    actorUrl,
    "Review this admin's grants"
  );

const isCreditGrant = (entry: AuditEntry): entry is AuditEntry & { actor: { userId: string } } =>
  (ADMIN_AUDIT_CREDIT_GRANT_ACTIONS as readonly string[]).includes(entry.action) &&
  typeof entry.details?.credits === 'number' &&
  entry.details.credits > 0 &&
  typeof entry.actor.userId === 'string';

/**
 * Decides whether a grant opens a new burst. A burst stays open while the actor keeps making
 * burst-level grants less than BURST_WINDOW_MS apart, so it alerts once, not once per grant.
 */
const evaluateBurst = async (
  entry: AuditEntry,
  openBursts: AdminAuditOpenBurst[],
  adapters: AdminAuditAlertAdapters
): Promise<{ grantCount: number; openBursts: AdminAuditOpenBurst[]; opensBurst: boolean } | null> => {
  if (!isCreditGrant(entry)) return null;
  const actorUserId = entry.actor.userId;
  const windowStart = new Date(entry.occurredAt.getTime() - BURST_WINDOW_MS);
  const grantCount = await adapters.db.adminAuditLog.countCreditGrants(actorUserId, {
    from: windowStart,
    to: entry.occurredAt,
  });
  if (grantCount <= BURST_GRANT_LIMIT) return null;

  const open = openBursts.find(burst => burst.actorUserId === actorUserId);
  const opensBurst = !open || open.lastGrantAt < windowStart;
  const others = openBursts.filter(burst => burst.actorUserId !== actorUserId);
  return { grantCount, opensBurst, openBursts: [...others, { actorUserId, lastGrantAt: entry.occurredAt }] };
};

const cursorOf = (entry: AuditEntry): AuditLogCursor => ({ occurredAt: entry.occurredAt, id: entry.id });

/**
 * One pass of the admin audit alert worker: posts every critical entry, and the first grant of each
 * credit-grant burst, past the stored cursor to the security Slack webhook. The cursor only moves
 * past entries whose message Slack accepted, so a failed post is retried on the next run.
 */
export const dispatchAdminAuditAlerts = async (
  adapters: AdminAuditAlertAdapters
): Promise<AdminAuditAlertRunResult> => {
  const { db, logger } = adapters;
  const now = adapters.now?.() ?? new Date();
  const until = new Date(now.getTime() - ALERT_SETTLE_MS);
  const caughtUp: AdminAuditAlertState = { cursor: { occurredAt: until, id: MIN_ENTRY_ID }, openBursts: [] };

  const state = await db.alertState.get();
  // First run: start from now rather than replaying the whole log into Slack.
  if (!state) {
    await db.alertState.save(caughtUp);
    logger.info('[ADMIN_AUDIT_ALERTS] initialized cursor', { cursor: caughtUp.cursor });
    return { status: 'initialized' };
  }
  // Alerts off: keep the cursor at now so turning them on later does not flood the channel with history.
  if (!adapters.webhookUrl) {
    if (state.cursor.occurredAt < until) await db.alertState.save(caughtUp);
    return { status: 'disabled' };
  }

  const entries = await db.adminAuditLog.listAscending({ after: state.cursor, until, limit: BATCH_LIMIT });
  let committed: Omit<AdminAuditAlertState, 'updatedAt'> = { cursor: state.cursor, openBursts: state.openBursts };
  let persisted = committed;
  let alerted = 0;
  let blocked = false;

  for (const entry of entries) {
    const burst = await evaluateBurst(entry, committed.openBursts, adapters);
    // One message per entry, so a retry never re-posts half of what an entry produced.
    const messages: string[] = [];
    if (entry.severity === 'critical') {
      messages.push(formatCriticalAlert(entry, adapters.toAppUrl(adminAuditLogPath({}, entry.id))));
    }
    if (burst?.opensBurst) {
      const actorPath = adminAuditLogPath({
        actorUserId: entry.actor.userId,
        category: 'credits',
        from: new Date(entry.occurredAt.getTime() - BURST_WINDOW_MS).toISOString(),
      });
      messages.push(formatBurstAlert(entry, burst.grantCount, adapters.toAppUrl(actorPath)));
    }

    if (messages.length > 0) {
      const posted = await adapters.postMessage(adapters.webhookUrl, messages.join('\n\n'));
      if (!posted) {
        logger.error('[ADMIN_AUDIT_ALERT_POST_FAILED]', { entryId: entry.id, action: entry.action });
        blocked = true;
        break;
      }
      alerted += 1;
    }
    committed = { cursor: cursorOf(entry), openBursts: burst?.openBursts ?? committed.openBursts };
    // Saved per accepted post so a later throw or Lambda timeout in this run does not re-send it.
    if (messages.length > 0) {
      await db.alertState.save(committed);
      persisted = committed;
    }
  }

  const pruneBefore = until.getTime() - BURST_WINDOW_MS;
  const openBursts = committed.openBursts.filter(burst => burst.lastGrantAt.getTime() >= pruneBefore);
  if (committed.cursor !== persisted.cursor || openBursts.length !== persisted.openBursts.length) {
    await db.alertState.save({ cursor: committed.cursor, openBursts });
  }
  return { status: 'ran', scanned: entries.length, alerted, blocked };
};
