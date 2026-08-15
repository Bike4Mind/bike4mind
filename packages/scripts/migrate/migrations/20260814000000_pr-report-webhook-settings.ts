import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * PR Status Digest: bot-token+channel -> incoming webhook.
 *
 * Two data changes the code rename cannot make on its own:
 *
 *  1. `prReportSlackChannel` was removed from the settings schema and replaced by the
 *     sensitive `prReportWebhookUrl`. Dropping the key from `SettingKeySchema` already
 *     hides the old row from every read, but the document lingers in `adminsettings`;
 *     delete it so nothing stale is left behind.
 *  2. The default egress allowlist changed from the Slack API origin
 *     (`slack.com` + `www.slack.com`) to the webhook host (`hooks.slack.com`). A fresh
 *     deployment picks up the new code default automatically, but a deployment that
 *     stored the OLD default would now reject every webhook send as `targetRejected`,
 *     because the guard checks the webhook URL's own host. Re-point such a row to the
 *     new default.
 *
 * The webhook URL itself is a secret and cannot be seeded - an admin must enter it.
 *
 * SAFETY: the allowlist is only touched when it holds EXACTLY the old Slack-API default.
 * An operator who customized it (added a proxy host, removed one) is left untouched, so
 * this can never clobber a deliberate configuration. Idempotent: a second run deletes no
 * channel row and finds the allowlist already migrated (or customized), so it changes
 * nothing.
 */

const OLD_DEFAULT_HOSTS = ['slack.com', 'www.slack.com'];
const NEW_DEFAULT_HOSTS = ['hooks.slack.com'];

/**
 * Read a `{ hosts: string[] }` egress value that may be stored as an object or as a JSON
 * string (settingValue is Mixed). Returns null when it is neither shape. Exported so the
 * shape handling is testable without a database.
 */
export function readEgressHosts(value: unknown): string[] | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const hosts = (parsed as { hosts?: unknown } | undefined)?.hosts;
  if (!Array.isArray(hosts)) return null;
  return hosts.filter((host): host is string => typeof host === 'string');
}

/** True only when `hosts` is exactly the old Slack-API default, order- and case-insensitive. */
export function isExactlyOldDefault(hosts: string[]): boolean {
  const normalize = (list: string[]) => [...list].map(host => host.trim().toLowerCase()).sort();
  const a = normalize(hosts);
  const b = normalize(OLD_DEFAULT_HOSTS);
  return a.length === b.length && a.every((host, index) => host === b[index]);
}

const migration: MigrationFile = {
  id: 20260814000000,
  name: 'pr-report-webhook-settings',

  up: async () => {
    // 1. Drop the orphaned channel setting.
    const removed = await AdminSettings.deleteMany({ settingName: 'prReportSlackChannel' });
    console.log(
      `[pr-report-webhook-settings] removed ${removed.deletedCount ?? 0} orphaned prReportSlackChannel row(s)`
    );

    // 2. Re-point an egress allowlist left at the old Slack-API default to the webhook host.
    const egress = await AdminSettings.findOne({ settingName: 'prReportEgressAllowlist' });
    if (!egress) {
      console.log(
        '[pr-report-webhook-settings] no stored egress allowlist; the code default (hooks.slack.com) applies'
      );
      return;
    }

    const hosts = readEgressHosts(egress.settingValue);
    if (!hosts || !isExactlyOldDefault(hosts)) {
      console.log('[pr-report-webhook-settings] egress allowlist is customized or already migrated; left unchanged');
      return;
    }

    // Preserve the stored form (string vs object) so this migration only changes content.
    const next =
      typeof egress.settingValue === 'string'
        ? JSON.stringify({ hosts: NEW_DEFAULT_HOSTS })
        : { hosts: NEW_DEFAULT_HOSTS };
    await AdminSettings.updateOne({ _id: egress._id }, { $set: { settingValue: next } });
    console.log(
      '[pr-report-webhook-settings] re-pointed egress allowlist from the old Slack-API default to hooks.slack.com'
    );
  },

  // Irreversible by design: we do not recreate a removed channel row, and re-pointing the
  // allowlist back to the Slack API host would just recreate the send-rejecting state.
  down: async () => {},
};

export default migration;
