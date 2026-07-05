import { ccBridgePairingTokenRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ensureTavernAccess } from '@server/utils/errors';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { z } from 'zod';

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_LABEL_PREFIX = 'cc-bridge';

const PairRequestSchema = z.object({
  // Restrict characters so device labels stay safely renderable in settings
  // UI / audit logs without introducing a separate escaping story. Spaces
  // and basic punctuation are allowed; control chars and HTML are not.
  deviceLabel: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\w\s.\-+:]+$/, 'deviceLabel can only contain letters, digits, spaces, or . - + : _')
    .optional(),
  platform: z.string().max(50).optional(),
});

/**
 * POST /api/cc-bridge/pair
 *
 * Auth'd endpoint invoked from the Tavern's "Connect Claude Code" button.
 * Mints a one-time pairing token (5 min TTL, bcrypt-hashed at rest) and
 * returns the plaintext pairing payload the bridge will redeem on first
 * run. The response shape matches the `pair.json` file that the eventual
 * download endpoint will bundle alongside the binary.
 */
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      req.logger.updateMetadata({ endpoint: 'cc-bridge/pair' });

      const userId = req.user?.id;
      if (!userId) {
        throw new BadRequestError('Missing authenticated user');
      }
      ensureTavernAccess(req.user);

      const parsed = PairRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.flatten(),
        });
      }

      const deviceLabel =
        parsed.data.deviceLabel?.trim() || `${DEFAULT_DEVICE_LABEL_PREFIX}-${randomBytes(3).toString('hex')}`;
      const platform = parsed.data.platform?.trim();

      const randomPart = randomBytes(16).toString('hex');
      const token = `b4mpair_${randomPart}`;
      const tokenPrefix = token.substring(0, 16);
      // Async variant so the ~300ms bcrypt CPU burn yields instead of pinning
      // a Lambda container mid-request for concurrent users.
      const tokenHash = await bcrypt.hash(token, 12);
      const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_MS);

      await ccBridgePairingTokenRepository.create({
        userId,
        tokenHash,
        tokenPrefix,
        deviceLabel,
        platform,
        expiresAt,
      });

      // Pin baseUrl to a trusted env var. Trusting request headers here lets
      // a CSRF + alternate-hostname attacker produce a pair.json pointing at
      // their own domain, which the bridge would then redeem against.
      const baseUrl = process.env.CC_BRIDGE_PUBLIC_URL ?? process.env.APP_URL;
      if (!baseUrl) {
        req.logger.error('[CC_BRIDGE] Neither CC_BRIDGE_PUBLIC_URL nor APP_URL is set; cannot mint pair.json');
        return res.status(500).json({ error: 'Server misconfigured: public URL not set' });
      }

      req.logger.info(`[CC_BRIDGE] Minted pairing token ${tokenPrefix}… for user ${userId}, device "${deviceLabel}"`);

      return res.status(201).json({
        pairingToken: token,
        expiresAt: expiresAt.toISOString(),
        deviceLabel,
        baseUrl,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
