import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { validateEmbedBranding, validateEmbedKeyOrigins } from '@server/services/publish';
import { logEvent } from '@server/utils/analyticsLog';
import { IEmbedBranding, UserApiKeyEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@server/utils/errors';

interface UpdateEmbedKeyRequest {
  /** Embed key configuration (epic #41 Phase E). Only provided fields change. */
  agentId?: string;
  allowedOrigins?: string[];
  branding?: IEmbedBranding;
}

// Not admin-gated: this is ownership-scoped self-service (same posture as the
// profile API-keys tab). `updateEmbedKey` resolves the key via
// `findByUserIdAndId`, so a caller can only ever configure their own keys.
const handler = baseApi().patch(
  asyncHandler<{}, unknown, UpdateEmbedKeyRequest, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    const keyId = req.query.id;
    const { agentId, allowedOrigins, branding } = req.body;

    if (!keyId) throw new BadRequestError('Invalid key ID');
    if (agentId === undefined && allowedOrigins === undefined && branding === undefined) {
      throw new BadRequestError('Nothing to update');
    }

    // Host-aware origin screen lives here (needs the runtime app host); the
    // service re-validates format/dedup/cap and the embed-scope invariant.
    let embedOrigins = allowedOrigins;
    if (allowedOrigins !== undefined) {
      const originsCheck = validateEmbedKeyOrigins(allowedOrigins);
      if (!originsCheck.ok) {
        throw new BadRequestError(originsCheck.error);
      }
      embedOrigins = originsCheck.value;
    }

    // Branding format screen (hex color, https logo, caps); the service
    // re-validates with the same shared schema.
    const brandingCheck = validateEmbedBranding(branding);
    if (!brandingCheck.ok) {
      throw new BadRequestError(brandingCheck.error);
    }

    const updated = await userApiKeyService.updateEmbedKey(
      userId,
      { keyId, agentId, allowedOrigins: embedOrigins, branding: brandingCheck.value },
      { db: { userApiKeys: userApiKeyRepository } }
    );

    await logEvent(
      {
        userId,
        type: UserApiKeyEvents.UPDATED,
        metadata: {
          keyId,
          name: updated.name,
          updatedFields: [
            ...(agentId !== undefined ? ['agentId'] : []),
            ...(allowedOrigins !== undefined ? ['allowedOrigins'] : []),
            ...(branding !== undefined ? ['branding'] : []),
          ],
        },
      },
      { ability: req.ability }
    );

    return res.status(200).json(updated);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
