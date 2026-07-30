import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { organizationRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { validateEmbedBranding, validateEmbedKeyOrigins } from '@server/services/publish';
import { gateEmbedBrandingWrite } from '@server/entitlements/embedKeyEntitlement';
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

// Not admin-gated at the route: `updateEmbedKey` resolves the key by ownership -
// the minter, or an admin of the org the key is billed to (mirroring the
// org-admin-aware LIST route). A caller who is neither gets a not-found.
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
    // re-validates with the same shared schema. The whitelabel write gate then
    // blocks only an unentitled hideBranding *elevation* against the key OWNER's
    // plan (same rule as the authoritative read gate); pass the stored value so
    // an unentitled member editing an unrelated branding field cannot clobber
    // white-label the org already earned.
    const brandingCheck = validateEmbedBranding(branding);
    if (!brandingCheck.ok) {
      throw new BadRequestError(brandingCheck.error);
    }
    // The stored value + owner only matter for an incoming hideBranding
    // elevation; skip the extra read on the common color/logo/name-only edit
    // (the gate is a no-op there anyway, and updateEmbedKey re-fetches the doc).
    let gatedBranding = brandingCheck.value;
    if (brandingCheck.value?.hideBranding === true) {
      // Resolve the elevation against the key's billing owner, not the caller.
      // Same minter-then-org-admin resolution as updateEmbedKey, so an org admin
      // editing a teammate's org key gates against the org's owner (matching the
      // ownerHasWhitelabel flag the LIST route computes). A key the caller neither
      // minted nor administers stays unresolved and fails closed to stripped;
      // updateEmbedKey then throws not-found regardless.
      let existing = await userApiKeyRepository.findByUserIdAndId(userId, keyId);
      if (!existing) {
        const administeredOrgIds = await organizationRepository.findIdsAdministeredBy(userId);
        existing = await userApiKeyRepository.findByOrganizationIdsAndId(administeredOrgIds, keyId);
      }
      gatedBranding = existing
        ? await gateEmbedBrandingWrite(existing, brandingCheck.value, existing.branding?.hideBranding === true)
        : { ...brandingCheck.value, hideBranding: false };
    }

    const updated = await userApiKeyService.updateEmbedKey(
      userId,
      { keyId, agentId, allowedOrigins: embedOrigins, branding: gatedBranding },
      { db: { userApiKeys: userApiKeyRepository, organizations: organizationRepository } }
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
