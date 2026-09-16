import { fabFileRepository } from '@bike4mind/database';
import { IAgent, isImageServeable } from '@bike4mind/common';
import { getFilesStorage } from '@server/utils/storage';

/**
 * Refresh agents' portrait signed URLs for display. `viewerId` is the REQUESTING user.
 *
 * Access gate: a signed URL is only ever minted/served for a file the agent's OWNER owns, or a
 * globally readable file. This stops an agent whose portraitUrl is pointed at a foreign private
 * file's path from leaking a signed URL to that file to anyone who can view the agent. Note
 * isImageServeable is a moderation check only and does NOT gate access, so this gate is separate.
 * Write-back gate: persisting the fresh URL mutates the FabFile record, so it is additionally
 * gated to the file's OWNER (viewerId) - a viewer of a *shared* agent still gets a freshly minted
 * display URL but never rewrites another user's FabFile record.
 *
 * Shared by GET /api/agents, GET /api/sessions/:id/agents and GET /api/agents/:id. These carried
 * near-identical copies before; the access gate must not drift between them, so it lives here once
 * rather than in each route. Held/blocked avatars are never re-minted.
 */
export const refreshAgentAvatarUrls = async (agents: IAgent[], viewerId: string): Promise<IAgent[]> => {
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
          // Check if the current URL is expired (older than 50 minutes)
          const now = new Date();
          const isExpired = !fabFile.fileUrlExpireAt || fabFile.fileUrlExpireAt <= now;

          if (isExpired) {
            // Generate a new signed URL
            const newSignedUrl = await getFilesStorage().getSignedUrl(fabFile.filePath);

            if (newSignedUrl) {
              // Persist the fresh URL only on the owner's own record - a shared-agent viewer
              // must not mutate a FabFile owned by someone else.
              if (fabFile.userId === viewerId) {
                const newExpireAt = new Date(now.getTime() + 3600 * 1000);
                await fabFileRepository.update({
                  ...fabFile,
                  fileUrl: newSignedUrl,
                  fileUrlExpireAt: newExpireAt,
                });
              }

              // Return the agent with the new URL
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
