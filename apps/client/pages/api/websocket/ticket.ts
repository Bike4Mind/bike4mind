import { wsConnectTicketRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { randomBytes } from 'crypto';

// Short window: a ticket is minted immediately before each (re)connect and
// burned at $connect. 30s absorbs clock skew and a slow handshake without
// leaving a usable replay window.
const TICKET_TTL_MS = 30 * 1000;

/**
 * POST /api/websocket/ticket
 *
 * Mints a single-use, short-TTL ticket that authenticates one web WebSocket
 * `$connect`. The web client fetches a fresh ticket per (re)connect and puts
 * it in the WS URL instead of the session JWT, keeping the long-lived
 * credential out of proxy/CDN/access logs.
 *
 * `tokenVersion` is captured from the (already JWT-authed) request so
 * `$connect` can re-run the tokenVersion kill-switch: if the user's version
 * is bumped between mint and connect, the captured version goes stale and the
 * connection is rejected.
 */
const handler = baseApi({ auth: true }).post(
  asyncHandler(async (req, res) => {
    req.logger.updateMetadata({ endpoint: 'websocket/ticket' });

    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestError('Missing authenticated user');
    }

    const ticket = randomBytes(32).toString('hex');
    await wsConnectTicketRepository.create({
      ticket,
      userId,
      tokenVersion: (req.user as { tokenVersion?: number }).tokenVersion ?? 0,
      expiresAt: new Date(Date.now() + TICKET_TTL_MS),
    });

    return res.status(201).json({ ticket });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
