import { sideAppAlertStateRepository, type OpenAlertRef } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { formatSideAppAlertMessage, type AlertPhase } from '@bike4mind/server-utils/sideApps/health/message';
import {
  PLATFORM_RULE,
  PLATFORM_SCOPE,
  reminderDue,
  type DesiredAlert,
  type OpenAlertKey,
  type SideAppAlertRule,
} from '@bike4mind/server-utils/sideApps/health/rules';

export interface ReconcileContext {
  now: Date;
  armedClientIds: string[];
  /** Display names by client id; an id with no name is left out. */
  lookupNames: (clientIds: string[]) => Promise<Map<string, string>>;
  appUrl?: string;
  stageLabel?: string;
  /** Resolves true only when Slack accepted the message. */
  post: (message: { text: string; blocks: unknown[] }) => Promise<boolean>;
}

export interface ReconcileResult {
  opened: number;
  reminded: number;
  resolved: number;
  postFailures: number;
}

const keyOf = (scope: string, rule: string) => `${scope}\u0000${rule}`;

interface Names {
  byClient: Map<string, string>;
  armed: string[];
}

function messageFor(
  phase: AlertPhase,
  alert: Pick<DesiredAlert, 'scope' | 'rule' | 'verdict'>,
  ctx: ReconcileContext,
  names: Names,
  openedAt?: Date
) {
  return formatSideAppAlertMessage({
    phase,
    rule: alert.rule as SideAppAlertRule | typeof PLATFORM_RULE,
    appName: names.byClient.get(alert.scope) ?? alert.scope,
    verdict: alert.verdict,
    armedAppNames: names.armed,
    appUrl: ctx.appUrl,
    stageLabel: ctx.stageLabel,
    openedForMs: openedAt ? ctx.now.getTime() - openedAt.getTime() : undefined,
  });
}

async function safePost(ctx: ReconcileContext, message: { text: string; blocks: unknown[] }, label: string) {
  try {
    if (await ctx.post(message)) return true;
  } catch (error) {
    Logger.warn('side app health alert post threw', {
      label,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
  Logger.warn('side app health alert post failed', { label });
  return false;
}

/**
 * Make the stored alert state match `desired`: announce new alerts once, remind every 24 hours while
 * open, announce recovery once. Opening is an insert guarded by a partial unique index, so a second
 * concurrent run gets a duplicate-key error and stays quiet. A muted alert is stored unannounced and
 * sent as a new alert once nothing mutes it. Recovery is posted before the alert is closed, under
 * the same claim as reminders, so a failed post leaves it open for the next run and two runs never
 * both post. An untracked alert (its app has no traffic left to judge) closes the same way with its
 * own message. An alert replaced by a different rule for the same app closes without a recovery
 * message. A failed post gives its claim back and never stops the remaining alerts. Database errors
 * propagate.
 */
export async function reconcileAlerts(
  desired: DesiredAlert[],
  ctx: ReconcileContext,
  untracked: OpenAlertKey[] = []
): Promise<ReconcileResult> {
  const result: ReconcileResult = { opened: 0, reminded: 0, resolved: 0, postFailures: 0 };
  const repo = sideAppAlertStateRepository;
  const open = await repo.listOpen();
  const openByKey = new Map<string, OpenAlertRef>(open.map(ref => [keyOf(ref.scope, ref.rule), ref]));
  const scopes = new Set([...desired.map(a => a.scope), ...open.map(r => r.scope), ...ctx.armedClientIds]);
  scopes.delete(PLATFORM_SCOPE);
  const byClient = await ctx.lookupNames([...scopes]);
  const names: Names = { byClient, armed: ctx.armedClientIds.map(id => byClient.get(id) ?? id) };

  for (const alert of desired) {
    const label = `${alert.scope}:${alert.rule}`;
    const existing = openByKey.get(keyOf(alert.scope, alert.rule));
    if (alert.muted) {
      if (!existing) await repo.open(alert.scope, alert.rule, ctx.now, false);
      continue;
    }

    if (!existing) {
      const opened = await repo.open(alert.scope, alert.rule, ctx.now);
      if (opened.outcome === 'exists') continue;
      if (await safePost(ctx, messageFor('open', alert, ctx, names), label)) {
        result.opened += 1;
      } else {
        result.postFailures += 1;
        await repo.releaseClaim(opened.id, ctx.now, undefined);
      }
      continue;
    }

    if (!reminderDue(existing.lastNotifiedAt, ctx.now.getTime())) continue;
    if (!(await repo.claimNotification(existing.id, existing.lastNotifiedAt, ctx.now))) continue;
    const phase: AlertPhase = existing.lastNotifiedAt ? 'reminder' : 'open';
    if (await safePost(ctx, messageFor(phase, alert, ctx, names), label)) {
      result[phase === 'open' ? 'opened' : 'reminded'] += 1;
    } else {
      result.postFailures += 1;
      await repo.releaseClaim(existing.id, ctx.now, existing.lastNotifiedAt);
    }
  }

  const keep = new Set(desired.map(alert => keyOf(alert.scope, alert.rule)));
  const desiredScopes = new Set(desired.map(alert => alert.scope));
  const untrackedKeys = new Set(untracked.map(alert => keyOf(alert.scope, alert.rule)));
  for (const ref of open) {
    if (keep.has(keyOf(ref.scope, ref.rule))) continue;
    // Nothing to retract when the alert never got out, or when another rule now covers the app.
    if (!ref.lastNotifiedAt || desiredScopes.has(ref.scope)) {
      await repo.resolve(ref.id, ctx.now);
      continue;
    }
    if (!(await repo.claimNotification(ref.id, ref.lastNotifiedAt, ctx.now))) continue;
    const phase: AlertPhase = untrackedKeys.has(keyOf(ref.scope, ref.rule)) ? 'untracked' : 'resolved';
    const resolvedMessage = messageFor(phase, { scope: ref.scope, rule: ref.rule }, ctx, names, ref.openedAt);
    if (await safePost(ctx, resolvedMessage, `${ref.scope}:${ref.rule}`)) {
      await repo.resolve(ref.id, ctx.now);
      result.resolved += 1;
    } else {
      result.postFailures += 1;
      await repo.releaseClaim(ref.id, ctx.now, ref.lastNotifiedAt);
    }
  }
  return result;
}
