import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';
import { baseApi } from '@server/middlewares/baseApi';
import { IUserDocument, UnprocessableEntityError, type IMessage } from '@bike4mind/common';
import {
  getEffectiveApiKeyByBackend,
  OperationsModelService,
} from '@bike4mind/server-utils/services/operationsModelService';
import { getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { meterCompletionBackend } from '@bike4mind/services';
import { createRequestCompletionMeter } from '@server/billing/meterPlatformCompletion';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';

interface BlogEnhanceParams {
  content: string;
  currentTitle: string;
  currentSummary: string;
  enhancementType: 'title' | 'summary';
}

interface BlogEnhanceResponse {
  success: boolean;
  message?: string;
  enhancedTitle?: string;
  enhancedSummary?: string;
}

async function enhanceContent(
  req: Parameters<typeof createRequestCompletionMeter>[0],
  user: IUserDocument,
  params: BlogEnhanceParams,
  logger: Logger
): Promise<BlogEnhanceResponse> {
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

    const llm = meterCompletionBackend(
      llmBackend,
      createRequestCompletionMeter(req, 'blog enhancement', { systemModel: true }),
      operationsModelInfo
    );
    const meteredComplete = async (messages: IMessage[], maxTokens: number): Promise<string> => {
      let text = '';
      await llm.complete(
        operationsModelInfo.id,
        messages,
        { temperature: 0.7, maxTokens, stream: false },
        async (textParts: (string | null | undefined)[]) => {
          text += textParts.filter(Boolean).join('');
        }
      );
      return text;
    };

    if (params.enhancementType === 'title') {
      // Generate title from content
      const prompt = `You are a professional blog title writer. Based on the following blog post content, generate a compelling, SEO-friendly title that accurately captures the main topic and hooks the reader.

Content:
${params.content}

${params.currentTitle ? `Current title: ${params.currentTitle}\n` : ''}

Instructions:
- Keep it concise (under 70 characters if possible)
- Make it engaging and clickable
- Ensure it accurately reflects the content
- Use power words when appropriate
- Don't use clickbait
- Return ONLY the title text, nothing else

Title:`;

      const enhancedTitle = await meteredComplete([{ role: 'user', content: prompt }], 150);

      return {
        success: true,
        enhancedTitle: enhancedTitle.trim(),
      };
    } else {
      // Generate summary from content
      const prompt = `You are a professional blog editor. Based on the following blog post content, write a compelling 1-2 sentence summary that would work as an excerpt or meta description.

Content:
${params.content}

${params.currentSummary ? `Current summary: ${params.currentSummary}\n` : ''}

Instructions:
- Keep it to 1-2 sentences (under 160 characters ideal for SEO)
- Make it engaging and encourage reading
- Capture the main value or takeaway
- Write in active voice
- Return ONLY the summary text, nothing else

Summary:`;

      const enhancedSummary = await meteredComplete([{ role: 'user', content: prompt }], 200);

      return {
        success: true,
        enhancedSummary: enhancedSummary.trim(),
      };
    }
  } catch (error) {
    console.error('Blog enhancement error:', error);
    throw error;
  }
}

const handler = baseApi().post(
  withRequestCompletionQuota(async (req, res) => {
    assertAiAccessAllowed(req.user);
    try {
      const params = req.body as BlogEnhanceParams;

      if (!params.content || !params.content.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Content is required',
        });
      }

      if (!params.enhancementType || !['title', 'summary'].includes(params.enhancementType)) {
        return res.status(400).json({
          success: false,
          message: 'Enhancement type must be either "title" or "summary"',
        });
      }

      const result = await enhanceContent(req, req.user, params, req.logger);

      return res.json(result);
    } catch (error) {
      // The credit reservation keeps its own 422 rather than collapsing into the generic 500.
      if (error instanceof UnprocessableEntityError) throw error;
      console.error('Blog enhance error:', error);
      return res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Failed to enhance blog content',
      });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
