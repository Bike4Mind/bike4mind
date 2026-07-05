import { z } from 'zod';
import { secureParameters } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { OperationsModelService } from '@client/services/operationsModelService';

const generateSmartNameSchema = z.object({
  prompt: z.string(),
  fileType: z.enum(['image', 'text']),
});

type GenerateSmartNameInput = z.infer<typeof generateSmartNameSchema>;

const handler = baseApi().post(async (req, res) => {
  try {
    const { prompt, fileType } = secureParameters(req.body, generateSmartNameSchema) as GenerateSmartNameInput;
    const fallbackName = fileType === 'image' ? `pasted-image-${Date.now()}` : `pasted-text-${Date.now()}`;

    try {
      const { modelId, llm } = await OperationsModelService.getOperationsModel();

      let result = '';
      await llm.complete(
        modelId,
        [{ role: 'user', content: prompt }],
        { maxTokens: 50, temperature: 0.7 },
        async (chunks: (string | null | undefined)[]) => {
          result += chunks.filter(Boolean).join('');
        }
      );

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
      req.logger.info('Operations model unavailable, using fallback name:', modelError);
      return res.status(200).json({ name: fallbackName });
    }
  } catch (error) {
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
