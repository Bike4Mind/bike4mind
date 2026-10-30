// packages/client/pages/api/agents/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { assertAgentsReadScope, assertAgentsWriteScope, AGENTS_READ_OR_WRITE_SCOPES } from '@server/agents/agentScopes';
import { agentRepository } from '@bike4mind/database';
import { IAgent } from '@bike4mind/common';
import { presentAgentsForViewer } from '@server/agents/presentAgentsForViewer';
import { createAgent } from '@server/agents/createAgent';

const ALLOWED_ORDER_BY = new Set(['createdAt', 'updatedAt', 'name']);

// baseApi's scope gate is per route, so it admits either agents scope and each method asserts its own.
const handler = baseApi({ requiredScopes: AGENTS_READ_OR_WRITE_SCOPES })
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    assertAgentsReadScope(req);
    const { query = '', page = '1', limit = '10', orderBy = 'updatedAt', orderDirection = 'desc' } = req.query;

    // Parse query parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    // Validate orderBy against an allow-list: the raw query string can name any field, and sorting
    // by the owner-only tavernSessionId would leak it as an ordering side channel to a shared viewer.
    const safeOrderBy = (ALLOWED_ORDER_BY.has(orderBy) ? orderBy : 'updatedAt') as 'createdAt' | 'updatedAt' | 'name';

    // Search for agents
    const result = await agentRepository.searchAccessible(
      req.user!.id,
      query,
      {},
      { page: pageNum, limit: limitNum },
      { by: safeOrderBy, direction: orderDirection as 'asc' | 'desc' }
    );

    const data: IAgent[] = result.data;

    res.json({
      ...result,
      data: await presentAgentsForViewer(data, req.user!.id),
    });
  })
  .post(async (req, res) => {
    assertAgentsWriteScope(req);
    try {
      const { agent, userCredits } = await createAgent(req.body as Partial<IAgent>, req.user!, undefined, req.logger);

      // Return agent and updated user credits
      return res.status(201).json({
        ...agent,
        userCredits,
      });
    } catch (error: any) {
      if (error.name === 'BadRequestError' || error.statusCode === 400) {
        req.logger.warn('Agent create rejected:', error.message);
        return res.status(400).json({ error: error.message });
      }
      req.logger.error('Error creating agent:', error);
      res
        .status(error.statusCode === 503 ? 503 : 500)
        .json({ error: 'Failed to create agent', details: error.message });
    }
  });

export default handler;
