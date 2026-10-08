// packages/client/pages/api/agents/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { assertAgentsReadScope, assertAgentsWriteScope, AGENTS_READ_OR_WRITE_SCOPES } from '@server/agents/agentScopes';
import { agentRepository } from '@bike4mind/database';
import { IAgent } from '@bike4mind/common';
import { refreshAgentAvatarUrls } from '@server/utils/refreshAgentAvatarUrls';
import { createAgent, type IAgentWithSystemPrompt } from '@server/agents/createAgent';

// baseApi's scope gate is per route, so it admits either agents scope and each method asserts its own.
const handler = baseApi({ requiredScopes: AGENTS_READ_OR_WRITE_SCOPES })
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    assertAgentsReadScope(req);
    const { query = '', page = '1', limit = '10', orderBy = 'updatedAt', orderDirection = 'desc' } = req.query;

    // Parse query parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    // Search for agents
    const result = await agentRepository.searchAccessible(
      req.user!.id,
      query,
      {},
      { page: pageNum, limit: limitNum },
      { by: orderBy as 'createdAt' | 'updatedAt', direction: orderDirection as 'asc' | 'desc' }
    );

    const data: IAgent[] = result.data;

    // Refresh avatar URLs for all agents BEFORE returning response
    const agentsWithRefreshedAvatars = await refreshAgentAvatarUrls(data, req.user!.id);

    res.json({
      ...result,
      data: agentsWithRefreshedAvatars,
    });
  })
  .post(async (req, res) => {
    assertAgentsWriteScope(req);
    try {
      const { agent, userCredits } = await createAgent(req.body as Partial<IAgentWithSystemPrompt>, req.user!.id);

      // Return agent and updated user credits
      return res.status(201).json({
        ...agent,
        userCredits,
      });
    } catch (error: any) {
      console.error('Error creating agent:', error);
      if (error.name === 'BadRequestError' || error.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to create agent', details: error.message });
    }
  });

export default handler;
