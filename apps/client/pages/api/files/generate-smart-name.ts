import { z } from 'zod';
import { UnprocessableEntityError, type IMessage } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { OperationsModelService } from '@client/services/operationsModelService';
import { FILES_WRITE_SCOPES } from '@server/files/fileScopes';
import {
  completionCeilingUsd,
  completionUsd,
  latchUsage,
  reserveCompletionCredits,
  settleCompletion,
  type CompletionUsage,
} from '@server/billing/meterPlatformCompletion';

const generateSmartNameSchema = z.object({
  prompt: z.string(),
  fileType: z.enum(['image', 'text']),
});

type GenerateSmartNameInput = z.infer<typeof generateSmartNameSchema>;

const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES }).post(async (req, res) => {
  try {
    const { prompt, fileType } = secureParameters(req.body, generateSmartNameSchema) as GenerateSmartNameInput;
    const fallbackName = fileType === 'image' ? `pasted-image-${Date.now()}` : `pasted-text-${Date.now()}`;

    try {
      const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel();

      const messages: IMessage[] = [{ role: 'user', content: prompt }];
      const maxTokens = 50;
      const ceilingUsd = completionCeilingUsd(modelInfo, messages, maxTokens);
      const reservation = await reserveCompletionCredits(req, ceilingUsd, 'smart file naming');

      let result = '';
      const usage: CompletionUsage = {};
      try {
        await llm.complete(
          modelId,
          messages,
          { maxTokens, temperature: 0.7 },
          async (chunks: (string | null | undefined)[], info) => {
            result += chunks.filter(Boolean).join('');
            latchUsage(usage, info);
          }
        );
      } catch (error) {
        await reservation.refund();
        throw error;
      }

      // An adapter that reports no usage is charged the reservation ceiling rather than nothing.
      const reported = Boolean(usage.inputTokens || usage.outputTokens || usage.turnUsage?.length);
      await settleCompletion(reservation, req, {
        model: modelId,
        provider: modelInfo.backend,
        usd: reported ? completionUsd(modelInfo, usage) : ceilingUsd,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
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
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
