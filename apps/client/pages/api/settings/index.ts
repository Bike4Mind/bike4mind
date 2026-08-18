import { AdminSettings } from '@bike4mind/database/infra';
import { redactSettingSecrets, type AdminSettingDoc } from '@bike4mind/common';
import { decryptAtRest } from '@bike4mind/utils/security';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';

// Get Admin Settings - returns the FULL AdminSettings collection, and is admin-only.
//
// A CASL `req.ability.can('read', AdminSettings)` check is NOT sufficient here: every
// authenticated user holds a *conditional* read rule for feature-flag settings
// (see server/auth/ability.ts), and CASL evaluates a subject-*type* check (the model class,
// not a document instance) as true whenever any conditional rule exists - the condition is
// never applied. That leaked every secret to any logged-in non-admin.
//
// Sensitive values are masked on the way out (the same redactor /api/settings/fetch uses),
// so an admin secret never leaves the server through this route either - the stored value
// is encrypted at rest, and only the mask (real last-4) is returned.
const handler = baseApi().get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const settings = await AdminSettings.find().lean();

  const redacted: AdminSettingDoc[] = (settings ?? []).map(setting => {
    const decrypted =
      typeof setting.settingValue === 'string'
        ? { ...setting, settingValue: decryptAtRest(setting.settingValue) }
        : setting;
    return redactSettingSecrets(decrypted as unknown as AdminSettingDoc);
  });

  return res.json(redacted);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
