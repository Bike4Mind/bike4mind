import { baseApi } from '@server/middlewares/baseApi';
import { IUserDocument, UnprocessableEntityError } from '@bike4mind/common';
import { getEffectiveApiKeyByBackend, OperationsModelService } from '@client/services/operationsModelService';
import { getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import {
  completionCeilingUsd,
  completionUsd,
  latchUsage,
  reserveCompletionCredits,
  settleCompletion,
  type CompletionUsage,
} from '@server/billing/meterPlatformCompletion';

interface GenerateImagePromptParams {
  content: string;
  title: string;
  summary: string;
}

interface GenerateImagePromptResponse {
  success: boolean;
  message?: string;
  prompt?: string;
}

async function generateImagePrompt(
  req: Parameters<typeof reserveCompletionCredits>[0],
  user: IUserDocument,
  params: GenerateImagePromptParams,
  logger: Logger
): Promise<GenerateImagePromptResponse> {
  try {
    const operationsModel = await OperationsModelService.getOperationsModel();
    const operationsModelInfo = operationsModel.modelInfo;

    const apiKey = await getEffectiveApiKeyByBackend(user.id, operationsModelInfo.backend);

    const apiKeyTable = {
      [operationsModelInfo.backend]: apiKey,
    };

    const llmBackend = getLlmByModel(apiKeyTable, { modelInfo: operationsModelInfo, logger, endUserId: user.id });

    if (!llmBackend) {
      throw new Error(`Could not create backend for ${operationsModelInfo.backend}/${operationsModelInfo.id}`);
    }

    // Create the prompt for generating a blog featured image description
    const systemPrompt = `You are an expert at creating image generation prompts for blog featured images.

Based on the blog post details provided, create a detailed, vivid image prompt that will generate an engaging featured image.

Guidelines:
- Capture the essence and mood of the blog post
- Create a visually interesting and engaging scene
- Make it work well as a hero/featured image for a blog
- Use descriptive, visual language
- Avoid including text or words in the image
- Keep it to 2-3 detailed sentences
- Focus on visual elements, composition, and atmosphere
- Consider lighting, colors, and mood

Return ONLY the image prompt, nothing else.`;

    const userPrompt = `Blog Title: ${params.title}

${params.summary ? `Summary: ${params.summary}\n\n` : ''}Content Preview:
${params.content.substring(0, 2000)}${params.content.length > 2000 ? '...' : ''}

Generate a detailed image prompt for a featured blog image that captures the essence of this blog post:`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];

    const maxTokens = 300;
    const ceilingUsd = completionCeilingUsd(operationsModelInfo, messages, maxTokens);
    const reservation = await reserveCompletionCredits(req, ceilingUsd, 'blog image prompt generation');

    let generatedPrompt = '';
    const usage: CompletionUsage = {};
    try {
      await llmBackend.complete(
        operationsModelInfo.id,
        messages,
        { temperature: 0.8, maxTokens, stream: false },
        async (textParts: (string | null | undefined)[], info) => {
          const fullText = textParts.filter(Boolean).join('');
          if (fullText) {
            generatedPrompt += fullText;
          }
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
      model: operationsModelInfo.id,
      provider: operationsModelInfo.backend,
      usd: reported ? completionUsd(operationsModelInfo, usage) : ceilingUsd,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    });

    if (!generatedPrompt.trim()) {
      throw new Error('Generated prompt was empty');
    }

    logger.log('[BlogImagePrompt] Generated prompt:', generatedPrompt.substring(0, 100) + '...');

    return {
      success: true,
      prompt: generatedPrompt.trim(),
    };
  } catch (error) {
    logger.error('[BlogImagePrompt] Error:', error);
    throw error;
  }
}

const handler = baseApi().post(async (req, res) => {
  try {
    const params = req.body as GenerateImagePromptParams;

    if (!params.content || !params.content.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Content is required',
      });
    }

    if (!params.title || !params.title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Title is required',
      });
    }

    const result = await generateImagePrompt(req, req.user, params, req.logger);

    return res.json(result);
  } catch (error) {
    // The credit reservation keeps its own 422 rather than collapsing into the generic 500.
    if (error instanceof UnprocessableEntityError) throw error;
    console.error('Blog image prompt generation error:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Failed to generate image prompt',
    });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
