import { ApiKeyScope, ReleaseNotesConfigSchema } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { loadReleaseNotesConfig, RELEASE_NOTES_SETTING } from '@server/releaseNotes/adminReleaseNotes';

// Validates only the keys sent; omitted keys keep their stored value (see the merge in PUT).
const ConfigPatchSchema = ReleaseNotesConfigSchema.partial().strict();

const requireAdmin = (user: { isAdmin?: boolean } | undefined) => {
  if (!user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(async (req, res) => {
    requireAdmin(req.user);
    return res.json(await loadReleaseNotesConfig(req.logger));
  })
  .put(async (req, res) => {
    requireAdmin(req.user);
    const patch = ConfigPatchSchema.safeParse(req.body);
    if (!patch.success) {
      throw new BadRequestError(
        patch.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      );
    }

    const { config: stored } = await loadReleaseNotesConfig(req.logger);
    // Zod still applies .default() under .partial(), so keep only the keys the caller actually sent.
    const sent = new Set(Object.keys(req.body as object));
    const definedPatch = Object.fromEntries(Object.entries(patch.data).filter(([key]) => sent.has(key)));
    const merged = ReleaseNotesConfigSchema.strict().parse({ ...stored, ...definedPatch });

    await AdminSettings.findOneAndUpdate(
      { settingName: RELEASE_NOTES_SETTING },
      { $set: { settingValue: merged } },
      { upsert: true, new: true }
    );
    invalidateSettingsCache(RELEASE_NOTES_SETTING);
    return res.json({ config: merged, malformed: false });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
