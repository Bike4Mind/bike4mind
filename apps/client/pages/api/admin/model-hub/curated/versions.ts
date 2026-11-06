import { z } from 'zod';
import { ApiKeyScope, BadRequestError, ConflictError } from '@bike4mind/common';
import {
  CURATED_CHANNEL,
  curatedDevKeysEnabled,
  curatedServerKeyring,
  importCuratedVersion,
} from '@bike4mind/server-utils/modelHub/curatedCatalog';
import { Config, isDeployedStage } from '@bike4mind/server-utils/utils/config';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

// Real lists are a few KB. A list near the 4 MiB cap, escaped into JSON and again into the Lambda event, may not
// fit the 6 MB request cap.
const MAX_BODY_BYTES = 6 * 1024 * 1024;

const ImportBody = z.object({
  manifest: z.string().min(1),
  signature: z.string().min(1),
  reason: z.unknown(),
});

/**
 * POST { manifest, signature, reason }: stores an already-signed curated list (an offline-signed hotfix or a
 * recovery revocation) as the next version, 201. `manifest` and `signature` are the exact texts of `latest.json` and
 * `latest.json.sig`; the same pair as live again is 200 `{ alreadyLive: true }` and stores nothing.
 */
const handler = adminApi({
  requiredScopes: [ApiKeyScope.ADMIN],
  maxBodySize: MAX_BODY_BYTES,
  adminPermissions: { POST: 'models:curate' },
}).post(async (req, res) => {
  const body = parseOrBadRequest(ImportBody, req.body);
  const reason = parseAdminActionReason(body.reason);
  const keyring = curatedServerKeyring(curatedDevKeysEnabled(process.env, Config.STAGE, isDeployedStage()));
  // The version and its strict audit entry commit together (importCuratedVersion runs both in one transaction).
  const result = await importCuratedVersion(
    { manifest: body.manifest, signature: body.signature, origin: 'import', publishedBy: req.user!.id, reason },
    keyring,
    {
      onStored: async (version, live) => {
        await recordAdminActionFromRequest(req, {
          action: 'model_hub.curated.imported',
          target: { kind: 'curatedCatalog', id: CURATED_CHANNEL, displayName: 'Curated models' },
          summary: `imported curated list sequence ${version.sequence}`,
          reason,
          changes: [
            { field: 'sequence', before: live?.sequence ?? null, after: version.sequence },
            { field: 'sha256', before: live?.sha256 ?? null, after: version.sha256 },
            { field: 'keyIds', before: live?.keyIds ?? null, after: version.keyIds },
          ],
        });
      },
    }
  );
  if (!result.ok) {
    if (result.status === 409) throw new ConflictError(result.error);
    throw new BadRequestError(result.error);
  }
  const { version } = result;
  if (result.alreadyLive) return res.status(200).json({ alreadyLive: true, sequence: version.sequence });
  return res.status(201).json({
    sequence: version.sequence,
    sha256: version.sha256,
    keyIds: version.keyIds,
    publishedAt: version.publishedAt.toISOString(),
  });
});

export const config = {
  api: { bodyParser: { sizeLimit: '6mb' } },
};

export default handler;
