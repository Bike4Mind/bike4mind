import { AdminSettings } from '@bike4mind/database/infra';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';

// Get Admin Settings - returns the FULL AdminSettings collection with unredacted
// settingValues (including provider API keys), so this route is admin-only.
//
// A CASL `req.ability.can('read', AdminSettings)` check is NOT sufficient here: every
// authenticated user holds a *conditional* read rule for feature-flag settings
// (see server/auth/ability.ts), and CASL evaluates a subject-*type* check (the model class,
// not a document instance) as true whenever any conditional rule exists - the condition is
// never applied. That leaked every secret to any logged-in non-admin.
// Non-admin/redacted reads must go through /api/settings/fetch, which filters by permitted
// keys and masks sensitive values.
const handler = baseApi().get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const settings = await AdminSettings.find();

  return res.json(settings);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
