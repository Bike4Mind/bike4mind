import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sessionRepository, agentRepository, fabFileRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { getFilesStorage } from '@server/utils/storage';
import { IAgent, IAgentDocument, redactSessionForClient, isImageServeable } from '@bike4mind/common';

const refreshAgentAvatarUrls = async (agents: IAgent[]): Promise<IAgent[]> => {
  const refreshedAgents = await Promise.all(
    agents.map(async agent => {
      if (!agent.visual?.portraitUrl) {
        return agent;
      }

      try {
        // S3 URLs look like: https://bucket.s3.region.amazonaws.com/filename.ext?params
        const url = new URL(agent.visual.portraitUrl);
        const pathname = url.pathname;
        const filename = pathname.substring(1);

        if (!filename || !filename.includes('.')) {
          return agent;
        }

        // The filePath in the database is just the filename, without the fab-files/ prefix
        const filePath = filename;

        const fabFile = await fabFileRepository.findOne({ filePath });
        // Don't re-mint a signed URL for a held/blocked avatar image
        if (fabFile && fabFile.filePath && isImageServeable(fabFile)) {
          // Check if the current URL is expired (older than 50 minutes)
          const now = new Date();
          const isExpired = !fabFile.fileUrlExpireAt || fabFile.fileUrlExpireAt <= now;

          if (isExpired) {
            const newSignedUrl = await getFilesStorage().getSignedUrl(fabFile.filePath);

            if (newSignedUrl) {
              const newExpireAt = new Date(now.getTime() + 3600 * 1000);
              await fabFileRepository.update({
                ...fabFile,
                fileUrl: newSignedUrl,
                fileUrlExpireAt: newExpireAt,
              });

              return {
                ...agent,
                visual: {
                  ...agent.visual,
                  portraitUrl: newSignedUrl,
                },
              };
            }
          } else {
            // URL is still valid, use the existing one
            return {
              ...agent,
              visual: {
                ...agent.visual,
                portraitUrl: fabFile.fileUrl || agent.visual.portraitUrl,
              },
            };
          }
        }
      } catch (error) {
        console.error(`Error refreshing avatar URL for agent ${agent.name}:`, error);
      }

      return agent;
    })
  );

  return refreshedAgents;
};

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

      const agentsWithRefreshedAvatars = await refreshAgentAvatarUrls(validAgents);

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

      // Verify the agent exists and the user has access (either owner or shared)
      const agent = await agentRepository.findById(agentId);
      if (!agent) {
        throw new NotFoundError('Agent not found');
      }

      const isSharedWithUser = agent.users?.some((u: { userId: string }) => u.userId === req.user!.id);
      if (agent.userId !== req.user!.id && !isSharedWithUser) {
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
