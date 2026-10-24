import { runAdminAuditAlerts } from '../cron/adminAuditAlerts';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted adminAuditAlerts cron's rate(1 minute) in infra/cron.ts. */
export const ADMIN_AUDIT_ALERTS_INTERVAL_MS = 60_000;

export function registerAdminAuditAlerts(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask('adminAuditAlerts', ADMIN_AUDIT_ALERTS_INTERVAL_MS, async () => {
    await runAdminAuditAlerts();
  });
}
