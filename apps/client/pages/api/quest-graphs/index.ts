import { questGraphRepository, sessionRepository } from '@bike4mind/database';
import { BadRequestError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireUser } from '@server/middlewares/requireUser';
import { requireExperimentalFeature } from '@server/middlewares/requireExperimentalFeature';
import { respond } from '@server/utils/respond';
import {
  QuestGraphCreatedResponseSchema,
  QuestGraphListResponseSchema,
  toQuestGraphWire,
} from '@server/questmaster/v5/wire';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const createRateLimit = rateLimit({ limit: 20, windowMs: 60000 });

const CreateGraphSchema = z.object({
  goal: z.string().min(1).max(4000),
  // Required, not optional: a graph's nodes dispatch agent executions, and
  // AgentExecution.sessionId is required. A graph created without a session
  // would accept nodes it could never run.
  sessionId: z.string().min(1),
  notebookId: z.string().min(1).optional(),
  budget: z
    .object({
      maxDepth: z.number().int().min(0).max(20).optional(),
      maxNodes: z.number().int().min(1).max(500).optional(),
      maxCredits: z.number().min(0).optional(),
      maxWallClockMs: z.number().int().min(0).optional(),
    })
    .optional(),
});

const handler = baseApi()
  .use(requireUser)
  .use(requireExperimentalFeature('enableQuestMasterV5'))
  .get<NextApiRequest, NextApiResponse>(async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const graphs = await questGraphRepository.findByUserId(req.user.id);
    respond(res, QuestGraphListResponseSchema, { graphs: graphs.map(toQuestGraphWire) });
  })
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), createRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');
    const input = CreateGraphSchema.parse(req.body);

    // Bind only to a session the caller owns - otherwise a graph could dispatch
    // runs into someone else's notebook, where their chat history would show
    // replies to prompts they never wrote.
    const session = await sessionRepository.findById(input.sessionId);
    if (!session || session.userId !== req.user.id) throw new BadRequestError('Session not found');

    const graph = await questGraphRepository.createGraph({
      goal: input.goal,
      userId: req.user.id,
      sessionId: input.sessionId,
      notebookId: input.notebookId,
      budget: input.budget,
    });

    respond(res, QuestGraphCreatedResponseSchema, { graph: toQuestGraphWire(graph) }, 201);
  });

export default handler;
