import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sessionRepository, agentRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { refreshAgentAvatarUrls } from '@server/utils/refreshAgentAvatarUrls';
import { IAgentDocument, redactSessionForClient } from '@bike4mind/common';

const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const { id: sessionId } = req.query;

      if (typeof sessionId !== 'string') {
        throw new BadRequestError('Invalid session ID');
      }

      const agentIds = await sessionRepository.getAttachedAgents(sessionId);
      const agents = await Promise.all(agentIds.map(agentId => agentRepository.findById(agentId)));

      // Filter out any null/undefined results (deleted agents)
      const validAgents = agents.filter((agent): agent is IAgentDocument => agent != null);

      const agentsWithRefreshedAvatars = await refreshAgentAvatarUrls(validAgents, req.user!.id);

      res.json({ agents: agentsWithRefreshedAvatars });
    })
  )
  .post(
    asyncHandler<{}, unknown, { agentId: string }, { id: string }>(async (req, res) => {
      const { id: sessionId } = req.query;
      const { agentId } = req.body;

      if (typeof sessionId !== 'string') {
        throw new BadRequestError('Invalid session ID');
      }

      if (!agentId || typeof agentId !== 'string') {
        throw new BadRequestError('Agent ID is required');
      }

      // Object-level authz honoring owner + user-shares + group-shares
      const agent = await agentRepository.shareable.findAccessibleById(req.user!, agentId);
      if (!agent) {
        throw new NotFoundError('Agent not found');
      }

      const updatedSession = await sessionRepository.attachAgent(sessionId, agentId);

      res.json({ session: redactSessionForClient(updatedSession) });
    })
  )
  .delete(
    asyncHandler<{}, unknown, { agentId: string }, { id: string }>(async (req, res) => {
      const { id: sessionId } = req.query;
      const { agentId } = req.body;

      if (typeof sessionId !== 'string') {
        throw new BadRequestError('Invalid session ID');
      }

      if (!agentId || typeof agentId !== 'string') {
        throw new BadRequestError('Agent ID is required');
      }

      const updatedSession = await sessionRepository.detachAgent(sessionId, agentId);

      res.json({ session: redactSessionForClient(updatedSession) });
    })
  );

export default handler;
