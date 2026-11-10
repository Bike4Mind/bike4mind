import { z } from 'zod';
import { ForbiddenError, type SettingKey } from '@bike4mind/common';
import { AdminSettings, adminSettingsRepository, withTransaction } from '@bike4mind/database';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { recordAdminSettingChange } from '@server/utils/adminSettingsAudit';
import type { AdminCheck, ApiBuilder } from './types';

const PutSchema = z.object({ enabled: z.boolean() });

export interface SettingsRouteOptions {
  api: ApiBuilder;
  /** The owner's switch. */
  settingName: SettingKey;
  isAdmin: AdminCheck;
}

/**
 * GET/PUT: the guided tutorials' admin switch. GET returns `{ enabled }`; PUT `{ enabled }` writes it.
 * Not behind the switch itself, so an admin can turn it on.
 */
export function settingsRoute({ api, settingName, isAdmin }: SettingsRouteOptions) {
  const requireAdmin = async (req: Parameters<AdminCheck>[0]) => {
    if (!(await isAdmin(req))) throw new ForbiddenError('Only full administrators can change tutorial settings.');
  };
  return api()
    .get(async (req, res) => {
      await requireAdmin(req);
      const [row] = await adminSettingsRepository.findBySettingNames([settingName]);
      return res.json({ enabled: String(row?.settingValue).toLowerCase() === 'true' });
    })
    .put(async (req, res) => {
      await requireAdmin(req);
      const parsed = PutSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'enabled must be true or false' });
      const { enabled } = parsed.data;
      // includeDeleted + deletedAt: null revives a soft-deleted row. The audit sits in the write's transaction,
      // so a failed audit rolls the switch back.
      await withTransaction(async () => {
        const prior = await AdminSettings.findOneAndUpdate(
          { settingName },
          { $set: { settingValue: enabled, deletedAt: null } },
          { upsert: true, returnDocument: 'before', includeDeleted: true }
        );
        await recordAdminSettingChange(req, {
          settingName,
          before: prior && !(prior as { deletedAt?: Date | null }).deletedAt ? prior.settingValue : null,
          after: enabled,
        });
      });
      invalidateSettingsCache(settingName);
      req.logger?.info({ actorId: req.user!.id, enabled, settingName }, 'Guided tutorials switched by admin');
      return res.json({ enabled });
    });
}
