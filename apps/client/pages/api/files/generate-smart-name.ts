import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';
import { z } from 'zod';
import { UnprocessableEntityError, type IMessage } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { FILES_WRITE_SCOPES } from '@server/files/fileScopes';
import { meterCompletionBackend } from '@bike4mind/services';
import { createRequestCompletionMeter } from '@server/billing/meterPlatformCompletion';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';

const generateSmartNameSchema = z.object({
  prompt: z.string(),
  fileType: z.enum(['image', 'text']),
});

type GenerateSmartNameInput = z.infer<typeof generateSmartNameSchema>;

const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES }).post(
  withRequestCompletionQuota(async (req, res) => {
    assertAiAccessAllowed(req.user);
    try {
      const { prompt, fileType } = secureParameters(req.body, generateSmartNameSchema) as GenerateSmartNameInput;
      const fallbackName = fileType === 'image' ? `pasted-image-${Date.now()}` : `pasted-text-${Date.now()}`;

      try {
        const operations = await OperationsModelService.getOperationsModel();
        const { modelId, modelInfo } = operations;
        const llm = meterCompletionBackend(
          operations.llm,
          createRequestCompletionMeter(req, 'smart file naming', { systemModel: true }),
          modelInfo
        );

        let result = '';
        const messages: IMessage[] = [{ role: 'user', content: prompt }];
        await llm.complete(modelId, messages, { maxTokens: 50, temperature: 0.7 }, async chunks => {
          result += chunks.filter(Boolean).join('');
        });

        const generatedName = result.trim();
        req.logger.info('Generated name from AI:', { generatedName, prompt: prompt.slice(0, 100) });

        const cleanName = generatedName
          ?.replace(/\.(txt|png|jpg|jpeg|gif|bmp|webp|pdf|doc|docx)$/i, '')
          ?.replace(/[^a-z0-9-]/gi, '-')
          ?.replace(/-+/g, '-')
          ?.replace(/^-|-$/g, '')
          ?.toLowerCase()
          ?.slice(0, 50);

        if (!cleanName) {
          req.logger.info('No clean name generated, using fallback');
          return res.status(200).json({ name: fallbackName });
        }

        req.logger.info('Returning clean name:', { cleanName });
        return res.status(200).json({ name: cleanName });
      } catch (modelError) {
        if (modelError instanceof UnprocessableEntityError) throw modelError;
        req.logger.info('Operations model unavailable, using fallback name:', modelError);
        return res.status(200).json({ name: fallbackName });
      }
    } catch (error) {
      // Insufficient credits must surface (422) instead of degrading to the fallback name.
      if (error instanceof UnprocessableEntityError) throw error;
      req.logger.error('Error generating smart filename:', error);
      const fallbackName = req.body.fileType === 'image' ? 'pasted-image' : 'pasted-text';
      return res.status(200).json({ name: fallbackName });
    }
  })
);

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
