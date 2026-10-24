import { resolveSettingDefinition, type AuditChange, type AuditEntry } from '@bike4mind/common';
import { adminAuditService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

type AuditRequest = Parameters<typeof recordAdminActionFromRequest>[0];

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSensitiveSetting = (settingName: string): boolean =>
  resolveSettingDefinition(settingName)?.isSensitive === true;

/** Large JSON settings (e.g. sreAgentConfig) record only the top-level keys that differ, one change each. */
export const diffSettingChanges = (field: string, before: unknown, after: unknown): AuditChange[] => {
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const subKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const changed = subKeys.filter(subKey => JSON.stringify(before[subKey]) !== JSON.stringify(after[subKey]));
    if (changed.length > 0) {
      return changed.map(subKey => ({ field: `${field}.${subKey}`, before: before[subKey], after: after[subKey] }));
    }
  }
  return [{ field, before, after }];
};

export type AdminSettingChange = {
  settingName: string;
  before: unknown;
  after: unknown;
  /** Defaults to "updated <settingName>", or "cleared <settingName>" when `after` is null. */
  summary?: string;
  /** Overrides the target for a write that is not the platform row (e.g. a scoped override). */
  target?: { id: string; displayName: string };
  details?: Record<string, unknown>;
};

/**
 * Strict `settings.admin_settings.updated` entry for any AdminSettings or scoped-settings write; call it
 * inside the write's transaction so a failed audit write rolls the change back. A sensitive setting's
 * value is never recorded, and nested secret-like keys are dropped by the writer's redactor.
 * The one shape every settings writer shares, so the Audit Log reads them all the same way.
 */
export const recordAdminSettingChange = (
  req: AuditRequest,
  { settingName, before, after, summary, target, details }: AdminSettingChange
): Promise<AuditEntry | null> =>
  recordAdminActionFromRequest(req, {
    action: 'settings.admin_settings.updated',
    target: { kind: 'settings', id: target?.id ?? settingName, displayName: target?.displayName ?? settingName },
    summary: summary ?? (after === null ? `cleared ${settingName}` : `updated ${settingName}`),
    changes: isSensitiveSetting(settingName)
      ? [
          {
            field: settingName,
            before: adminAuditService.REDACTED_PLACEHOLDER,
            after: adminAuditService.REDACTED_PLACEHOLDER,
          },
        ]
      : diffSettingChanges(settingName, before, after),
    details,
  });
