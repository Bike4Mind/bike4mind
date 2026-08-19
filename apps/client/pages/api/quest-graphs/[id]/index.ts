import { BadRequestError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { requireUser } from '@server/middlewares/requireUser';
import { requireExperimentalFeature } from '@server/middlewares/requireExperimentalFeature';
import { respond } from '@server/utils/respond';
import { requireOwnedGraph } from '@server/questmaster/v5/questGraphAccess';
import { loadGraphDetail } from '@server/questmaster/v5/loadGraphDetail';
import { QuestGraphDetailResponseSchema } from '@server/questmaster/v5/wire';
import { Logger } from '@bike4mind/observability';
import { NextApiRequest, NextApiResponse } from 'next';

const logger = new Logger({ metadata: { component: 'questmaster-v5-graph' } });

const handler = baseApi()
  .use(requireUser)
  .use(requireExperimentalFeature('enableQuestMasterV5'))
  .get<NextApiRequest, NextApiResponse>(async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const { id } = req.query;
    if (typeof id !== 'string') throw new BadRequestError('Graph id required');

    const graph = await requireOwnedGraph(id, req.user.id);
    const detail = await loadGraphDetail(graph, logger);

    respond(res, QuestGraphDetailResponseSchema, detail);
  });

export default handler;
