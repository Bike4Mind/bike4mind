import { fabFileRepository } from '@bike4mind/database';
import { IAgent, isImageServeable } from '@bike4mind/common';
import { fileUrlSigningDate, FILE_URL_TTL_SECONDS } from '@bike4mind/utils';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';

/**
 * Refresh agents' portrait signed URLs for display. `viewerId` is the REQUESTING user.
 *
 * Access gate: a signed URL is only ever minted/served for a file the agent's OWNER owns, or a
 * globally readable file. This stops an agent whose portraitUrl is pointed at a foreign private
 * file's path from leaking a signed URL to that file to anyone who can view the agent. Note
 * isImageServeable is a moderation check only and does NOT gate access, so this gate is separate.
 * The fresh URL is only returned, never written back to the FabFile record.
 *
 * Shared by GET /api/agents, GET /api/sessions/:id/agents and GET /api/agents/:id (through
 * `server/agents/presentAgentsForViewer`). These carried near-identical copies before; the access
 * gate must not drift between them, so it lives here once rather than in each route. Held/blocked
 * avatars are never re-minted.
 */
export const refreshAgentAvatarUrls = async (agents: IAgent[], _viewerId: string): Promise<IAgent[]> => {
  const refreshedAgents = await Promise.all(
    agents.map(async agent => {
      // Skip if no portrait URL
      if (!agent.visual?.portraitUrl) {
        return agent;
      }

      try {
        // Extract the filename from the S3 URL
        // URLs look like: https://bucket.s3.region.amazonaws.com/filename.ext?params
        const url = new URL(agent.visual.portraitUrl);
        const pathname = url.pathname; // This gives us "/filename.ext"
        const filename = pathname.substring(1); // Remove the leading "/"

        if (!filename || !filename.includes('.')) {
          return agent;
        }

        // The filePath in the database should be just the filename (without fab-files/ prefix)
        const filePath = filename;

        // Find the corresponding FabFile to get proper signed URL
        const fabFile = await fabFileRepository.findOne({ filePath });
        // Only serve a file the agent's owner owns, or a globally readable file - never a foreign
        // private file resolved by path alone. isImageServeable is moderation-only, not access.
        const viewerMayReadFile = !!fabFile && (fabFile.userId === agent.userId || fabFile.isGlobalRead);
        if (fabFile && fabFile.filePath && isImageServeable(fabFile) && viewerMayReadFile) {
          const newSignedUrl = await getFilesStorage().getSignedUrl(fabFile.filePath, 'get', {
            expiresIn: FILE_URL_TTL_SECONDS,
            signingDate: fileUrlSigningDate(),
          });

          if (newSignedUrl) {
            return {
              ...agent,
              visual: {
                ...agent.visual,
                portraitUrl: newSignedUrl,
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
