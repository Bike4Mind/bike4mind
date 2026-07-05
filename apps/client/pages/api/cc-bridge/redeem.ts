import { CcBridgeDevice, ccBridgeDeviceRepository, ccBridgePairingTokenRepository } from '@bike4mind/database';
import { UserApiKey, userApiKeyRepository } from '@bike4mind/database/auth';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
import { userApiKeyService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

/**
 * Take the last hop from the X-Forwarded-For chain - that's the one CloudFront
 * appends and can't be spoofed by the client, unlike earlier entries. `req.ip`
 * on an unauth endpoint behind a proxy is attacker-controllable and would
 * otherwise poison audit logs / baseline calculations.
 */
function trustedClientIp(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress;
}

const RedeemRequestSchema = z.object({
  pairingToken: z.string().min(16).max(200),
  deviceLabel: z.string().min(1).max(100),
  platform: z.string().max(50).optional(),
  bridgeVersion: z.string().max(30).optional(),
});

/**
 * POST /api/cc-bridge/redeem
 *
 * Unauth'd endpoint the bridge hits once on first run. Exchanges a
 * valid, unredeemed, unexpired pairing token for (1) a newly-minted
 * durable API key scoped to cc-bridge only and (2) a `CcBridgeDevice`
 * record pinned to that key.
 *
 * The plaintext API key is returned exactly once, in this response.
 * After this call the token is burned and cannot be reused.
 *
 * Rate-limited on the IP path by the `rateLimit` middleware: 20
 * redeem attempts per minute per (ip, path) key. Without this the
 * unauth endpoint would be an unlimited oracle for prefix collisions.
 */
const handler = baseApi({ auth: false })
  .use(rateLimit({ limit: 20, windowMs: 60_000 }))
  .post(
    asyncHandler(async (req, res) => {
      req.logger.updateMetadata({ endpoint: 'cc-bridge/redeem' });

      const parsed = RedeemRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.flatten(),
        });
      }

      const { pairingToken, deviceLabel, platform, bridgeVersion } = parsed.data;
      const tokenPrefix = pairingToken.substring(0, 16);

      // tokenPrefix is not unique; walk every candidate under the same
      // prefix and bcrypt-compare. In practice there's at most one
      // unredeemed candidate at any time, but the set size is bounded
      // by the 5-min TTL so this is cheap even in a worst-case burst.
      const candidates = await ccBridgePairingTokenRepository.findUnredeemedCandidatesByPrefix(tokenPrefix);
      let record: (typeof candidates)[number] | null = null;
      for (const candidate of candidates) {
        if (await bcrypt.compare(pairingToken, candidate.tokenHash)) {
          record = candidate;
          break;
        }
      }

      if (!record) {
        // Log the prefix only - never the userId. Attaching the userId here
        // turns a failed guess into an oracle: an attacker iterating prefixes
        // would harvest {prefix -> userId} mappings out of log aggregation.
        req.logger.warn(`[CC_BRIDGE] Redeem failed for prefix ${tokenPrefix}`);
        return res.status(401).json({ error: 'Invalid or expired pairing token' });
      }

      const createdKey = await userApiKeyService.createUserApiKey(
        record.userId,
        {
          name: `cc-bridge: ${deviceLabel}`,
          // Dedicated, narrow scope - the bridge only needs the WS cc_agent_*
          // actions; granting AI_CHAT would let a leaked bridge key bill
          // completions on the user's account.
          scopes: [ApiKeyScope.CC_BRIDGE],
          metadata: {
            clientIP: trustedClientIp(req),
            userAgent: req.headers['user-agent'],
            createdFrom: 'bridge' as const,
          },
        },
        { db: { userApiKeys: userApiKeyRepository } }
      );

      const device = await ccBridgeDeviceRepository.create({
        userId: record.userId,
        deviceLabel,
        apiKeyId: createdKey.id,
        platform: platform ?? record.platform,
        bridgeVersion,
        pairedAt: new Date(),
      });

      const burned = await ccBridgePairingTokenRepository.redeem(record._id, device._id);
      if (!burned) {
        // Token was redeemed by a concurrent request between our lookup and our burn.
        // Roll back the orphaned key + device - otherwise the loser of the race
        // leaves behind an active CC_BRIDGE key tied to no redeemed pairing.
        req.logger.warn(
          `[CC_BRIDGE] Lost redemption race for token ${tokenPrefix}, user ${record.userId}; rolling back`
        );
        try {
          await UserApiKey.updateOne({ _id: createdKey.id }, { $set: { status: ApiKeyStatus.DISABLED } });
          await CcBridgeDevice.deleteOne({ _id: device._id });
        } catch (rollbackErr) {
          req.logger.error(`[CC_BRIDGE] Rollback after lost race failed for key ${createdKey.id}`, rollbackErr);
        }
        return res.status(409).json({ error: 'Pairing token already redeemed' });
      }

      req.logger.info(
        `[CC_BRIDGE] Redeemed token ${tokenPrefix} for user ${record.userId}, device ${device._id} ("${deviceLabel}")`
      );

      return res.status(201).json({
        deviceId: device._id,
        deviceLabel: device.deviceLabel,
        userId: record.userId,
        apiKey: createdKey.key,
        apiKeyPrefix: createdKey.keyPrefix,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
