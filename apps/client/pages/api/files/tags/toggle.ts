import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  userRepository,
  adminSettingsRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { fileTagRepository } from '@bike4mind/database';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { assertDataLakeTagWriteScope, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    if (!req.user.id) {
      throw new ForbiddenError('Unauthorized');
    }

    // Toggling a lake's `datalake:*` meta-tag onto a file is a WRITE into that lake, so gate it
    // with the creator/admin check so this path can't inject files into a lake the caller only
    // reads (mirrors the remove path).
    //
    // This gate covers meta-tag names ONLY and deliberately is not extended to cover a
    // fileTagPrefix content tag (also membership, since #1263): it has no resolved file list, so
    // it cannot know the file OWNER a prefix-arm leave/join is anchored to. That check lives
    // entirely in the service layer (`toggleTags`'s own prefix-arm gate below) - do not duplicate
    // it here.
    const toggledTags: string[] = Array.isArray((req.body as { tags?: unknown })?.tags)
      ? (req.body as { tags: unknown[] }).tags.filter((t): t is string => typeof t === 'string')
      : [];
    // This route is not under /api/data-lakes and stays ungated for a plain file-tag toggle, so a
    // files:write-only key keeps working. But when the payload actually reaches into a lake (a
    // datalake:* meta-tag), an API-key caller must hold datalake:write - otherwise a key minted for
    // file tagging alone could add/remove a file from a lake it cannot otherwise write into.
    assertDataLakeTagWriteScope(req, toggledTags);
    const settingsStores = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
    // No `members` here on purpose: a toggle is direction-neutral, so this route cannot tell a join
    // from a leave and would refuse removals. The admission contract (#1680) runs inside
    // `toggleTags`, at the exact branch that makes a file a member.
    const ctx = await toAccessContext(req);
    // Full actor, not a `{ userId, isAdmin }` literal: `canManageLake`'s org-admin rung reads
    // `administeredOrgIds`, which cannot be derived from the user document, so a literal here
    // makes this gate strictly narrower than every other lake-management gate in the app.
    await dataLakeService.assertCanWriteDataLakeTags(ctx, toggledTags, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        ...settingsStores,
      },
    });

    const result = await fabFilesService.toggleTags(req.user.id, req.body, {
      db: {
        fabFiles: fabFileRepository,
        fileTags: fileTagRepository,
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        users: userRepository,
        ...lakeConfigAuditDb,
        ...settingsStores,
      },
      // The service re-gates every lake this toggle joins or leaves, so its actor has to stay as
      // wide as the prologue gate above - the org rungs of `canManageLake` cannot be derived from
      // the user document the service is handed.
      administeredOrgIds: ctx.administeredOrgIds,
      // Covers the fileTagPrefix membership arm the prologue gate above cannot see (it has no
      // resolved file list) - called only when the service actually finds a prefix-arm join/leave.
      assertWriteScope: () => assertDataLakeWriteScope(req),
      // Matches every other audited config-write door (#1917): undefined for a session caller,
      // the key's principal for a `b4m_live_` caller - so a toggle that auto-activates a draft
      // lake attributes the History row to the key, not the human.
      auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
      logger: req.logger,
    });

    return res.json(result);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
