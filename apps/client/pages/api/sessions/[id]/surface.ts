import { sessionService } from '@bike4mind/services';
import { sessionRepository } from '@bike4mind/database';
import { ApiKeyScope, redactSessionForClient } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { surfaceAccessForRequest } from '@server/entitlements/surfaceAccess';
import { BadRequestError } from '@server/utils/errors';
import { parseTargetSurface } from '@server/utils/parseTargetSurface';
import { Request } from 'express';

/**
 * PATCH /api/sessions/[id]/surface - move the caller's own session into another registered
 * workspace (`{ targetSurface: string | null }`, null = the main notebook list). Internal web route,
 * not a public contract; the registry and entitlement rules live in @bike4mind/common's surfaces.ts.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.WRITE_NOTEBOOKS] }).patch(
  async (req: Request<{}, {}, { targetSurface?: unknown }, { id?: string }>, res) => {
    const sessionId = req.query.id;
    if (!sessionId) throw new BadRequestError('Session ID is required');

    // Unlike clone/fork there is no "inherit" here: a move must name its destination.
    const targetSurface = parseTargetSurface(req.body);
    if (targetSurface === undefined) throw new BadRequestError('targetSurface is required');

    const session = await sessionService.moveSession(
      req.user.id,
      { id: sessionId, targetSurface },
      {
        db: { sessions: sessionRepository },
        resolveSurfaceAccess: surfaceAccessForRequest(req),
      }
    );

    return res.json(redactSessionForClient(session));
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
