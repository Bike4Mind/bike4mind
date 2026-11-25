/**
 * POST /api/v1/obligations - hand a scanned document to the assistant (201 new, 200 already handed off).
 * GET  /api/v1/obligations - list the caller's obligations, cursor-paginated.
 */
import { ForbiddenError, handOffObligationContract, listObligationsContract } from '@bike4mind/common';
import { obligationRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { createHandOffDeps, handOffDocument } from '@server/obligations/handOffDocument';
import { serializeObligation } from '@server/obligations/serializeObligation';
import { canFileObligationIntoLakes, canReadObligationLakes } from '@server/obligations/obligationLakeScopes';

const CURSOR_SCOPE = 'v1.obligations';

const handOffRoute = nextRouteForContract(handOffObligationContract, {
  rateLimit: perUserRateLimit('POST /api/v1/obligations'),
}).post(async (req, res) => {
  // An obligation reads the user's files, spends credits and files into lakes, none of which a connected app is granted.
  if (req.apiKeyInfo?.oauthExchangeClientId) {
    throw new ForbiddenError('Keys minted for a connected app cannot use obligations');
  }
  // A suggestion only a confirm can act on, so it needs the scope confirm needs to file it.
  const deps = createHandOffDeps(await toMemberAccessContext(req), req.logger, {
    offerLakes: canFileObligationIntoLakes(req.apiKeyInfo),
  });
  const { obligation, created } = await handOffDocument(req.user.id, req.validated, deps);
  return res
    .status(created ? 201 : 200)
    .json(serializeObligation(obligation, { showDestination: canReadObligationLakes(req.apiKeyInfo) }));
});

const listRoute = nextRouteForContract(listObligationsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/obligations'),
}).get(async (req, res) => {
  // An obligation reads the user's files, spends credits and files into lakes, none of which a connected app is granted.
  if (req.apiKeyInfo?.oauthExchangeClientId) {
    throw new ForbiddenError('Keys minted for a connected app cannot use obligations');
  }
  const { limit, cursor, status } = req.validatedQuery;
  const afterId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  if (afterId !== undefined && !isValidObjectId(afterId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }
  const rows = await obligationRepository.listForUser(req.user.id, { cursor: afterId, limit: limit + 1, status });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const showDestination = canReadObligationLakes(req.apiKeyInfo);

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    data: page.map(item => serializeObligation(item, { showDestination })),
    next_cursor: rows.length > limit && last ? encodeCursor(CURSOR_SCOPE, last._id.toString()) : null,
  });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRoute, POST: handOffRoute });
