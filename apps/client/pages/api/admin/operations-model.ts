import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { OperationsModelService } from '@client/services/operationsModelService';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';
import { SpeechToTextModels } from '@bike4mind/common';

const UpdateOperationsModelSchema = z.object({
  modelId: z.string(),
  imageModelId: z.string(),
  speechModelId: z.string(),
});

const handler = baseApi()
  .get(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const config = await OperationsModelService.getOperationsModelConfig();

      if (!config) {
        // Return default config
        return res.json({
          modelId: 'gpt-4o-mini',
          imageModelId: 'flux-pro',
          speechModelId: 'whisper-1',
        });
      }

      return res.json(config);
    } catch (error) {
      console.error('Error getting operations model config:', error);
      return res.status(500).json({
        error: 'Failed to get operations model configuration',
      });
    }
  })
  .put(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const config = UpdateOperationsModelSchema.parse(req.body);

      // Update the configuration
      await OperationsModelService.updateOperationsModel(config);

      // Get speech model info from list for response
      const speechModels = [
        { id: SpeechToTextModels.WHISPER_1, name: 'Whisper-1' },
        { id: SpeechToTextModels.AWS_TRANSCRIBE, name: 'Amazon Transcribe' },
      ];

      const speechModelInfo = speechModels.find(m => m.id === config.speechModelId);

      try {
        // Test that the new configuration works
        const result = await OperationsModelService.getOperationsModel();

        return res.json({
          success: true,
          config,
          activeModel: {
            id: result.modelId,
            name: result.modelInfo.name,
            imageModelId: result.imageModelId,
            imageModelName: result.imageModelInfo.name,
            speechModelId: config.speechModelId, // Use the saved config, not the result
            speechModelName: speechModelInfo?.name || config.speechModelId,
          },
        });
      } catch (error) {
        // Even if initialization fails, return the saved config
        console.warn('Model initialization failed, but config was saved:', error);
        return res.json({
          success: true,
          config,
          activeModel: {
            id: config.modelId,
            name: config.modelId, // Fallback to ID if name not available
            imageModelId: config.imageModelId,
            imageModelName: config.imageModelId, // Fallback to ID if name not available
            speechModelId: config.speechModelId,
            speechModelName: speechModelInfo?.name || config.speechModelId,
          },
        });
      }
    } catch (error) {
      console.error('Error updating operations model:', error);
      return res.status(500).json({
        error: 'Failed to update operations model configuration',
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
