/**
 * GET /api/v1/briefs/busy-blocks - the caller's synced busy blocks and the next block brief's due time.
 * PUT /api/v1/briefs/busy-blocks - replace them from the device calendar; times only, no event details.
 * JWT only; reads and writes only `req.user`.
 */
import { getBusyBlocksContract, putBusyBlocksContract } from '@bike4mind/common';
import { userRepository, type BusyBlocksState } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const toResponse = ({ enabled, blocks, nextBlockBriefAt }: BusyBlocksState) => ({
  enabled,
  blocks: blocks.map(({ start, end }) => ({ start: start.toISOString(), end: end.toISOString() })),
  nextBlockBriefAt: nextBlockBriefAt?.toISOString() ?? null,
});

const getRoute = nextRouteForContract(getBusyBlocksContract, {
  rateLimit: perUserRateLimit('GET /api/v1/briefs/busy-blocks'),
  recordsActivity: false,
}).get(async (req, res) => {
  return res.json(toResponse(await userRepository.getBusyBlocks(req.user.id)));
});

const putRoute = nextRouteForContract(putBusyBlocksContract, {
  rateLimit: perUserRateLimit('PUT /api/v1/briefs/busy-blocks'),
}).put(async (req, res) => {
  const { enabled, blocks } = req.validated;
  const state = await userRepository.setBusyBlocks(
    req.user.id,
    { enabled, blocks: blocks.map(({ start, end }) => ({ start: new Date(start), end: new Date(end) })) },
    new Date()
  );
  return res.json(toResponse(state));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: getRoute, PUT: putRoute });
