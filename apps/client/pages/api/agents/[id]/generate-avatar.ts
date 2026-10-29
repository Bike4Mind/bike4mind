import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { AGENTS_WRITE_SCOPES } from '@server/agents/agentScopes';
import { assertAgentAccess } from '@server/agents/assertAgentAccess';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { agentRepository } from '@bike4mind/database';
import {
  BadRequestError,
  ExpectedImageGenerationError,
  logImageGenerationFailure,
  checkStorageLimit,
} from '@bike4mind/utils';
import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
import imageLogger from '@bike4mind/server-utils/utils/imageLogger';
import { generateAgentAvatar } from '@server/agents/authoring/generateAgentAvatar';

interface AgentAvatarRequest {
  imageModel?: string;
}

interface AgentAvatarResponse {
  portraitUrl: string;
  generationPrompt: string;
}

const handler = baseApi({ requiredScopes: AGENTS_WRITE_SCOPES }).post<
  Request<{ id: string }, AgentAvatarResponse, AgentAvatarRequest>
>(
  withRequestCompletionQuota(async (req, res) => {
    assertAiAccessAllowed(req.user);
    const { id } = req.query;
    const userId = req.user!.id;
    const { imageModel: userImageModel } = req.body;

    // Validate the id parameter
    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Invalid agent ID');
    }

    // Find the agent
    const agent = await agentRepository.findById(id);
    assertAgentAccess(agent, userId, 'own');

    // Cheap early refusal: checkStorageLimit does no DB I/O (b4m-core/utils/src/user.ts),
    // it only reads fields already on req.user, so an already-over-quota user is turned
    // away before paying for image generation, moderation, and the download. The exact
    // check against imageBuffer.length still runs later to catch the request that only
    // goes over because of this specific image.
    await checkStorageLimit(req.user!, 0);

    try {
      res.json(await generateAgentAvatar(agent, req.user!, userImageModel, req.logger));
    } catch (error) {
      logImageGenerationFailure(imageLogger, 'Error generating agent avatar:', error, { agentId: agent.id, userId });

      // Let the shared error handler render this with its real status and message
      // (400 with a storage `code` and byte counts), same as every other upload door.
      if (error instanceof BadRequestError) {
        throw error;
      }

      // Provide user-friendly error messages
      let errorMessage = 'Failed to generate avatar. Please try again.';
      // Two different moderation classes: this one is the provider refusing to generate (from
      // @bike4mind/utils), the Rekognition one below is our own scan of the generated image.
      if (error instanceof ExpectedImageGenerationError) {
        errorMessage = error.message;
      } else if (error instanceof ImageModerationBlockedError) {
        errorMessage = 'Generated avatar was flagged by content moderation and could not be saved. Please try again.';
      } else if (error instanceof Error) {
        if (error.message.includes('API key') || error.message.includes('model')) {
          errorMessage = 'AI service temporarily unavailable. Please try again later.';
        } else if (error.message.includes('credits')) {
          errorMessage = 'Insufficient credits to generate avatar.';
        } else if (error.message.includes('upload')) {
          errorMessage = 'Generated avatar but failed to save. Please try again.';
        }
      }

      res.status(500).json({ error: errorMessage });
    }
  })
);

export default handler;
