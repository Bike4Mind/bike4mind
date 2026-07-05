import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { OperationsModelService } from '@client/services/operationsModelService';

export interface RephraseRequest {
  text: string;
  style?: 'optimized' | 'concise' | 'professional' | 'casual';
  maxLength?: number;
}

export interface RephraseResponse {
  optimizedText: string;
  originalLength: number;
  optimizedLength: number;
}

const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 50 : 20,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: any, res) => {
    const { text, style = 'optimized', maxLength }: RephraseRequest = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        error: 'Text is required for optimization',
      });
    }

    try {
      const { modelId, llm } = await OperationsModelService.getOperationsModel();

      const styleDescriptions: Record<NonNullable<RephraseRequest['style']>, string> = {
        optimized:
          'clearer, more specific, and actionable while eliminating ambiguity, adding concrete examples where helpful, structuring information logically, defining key terms, specifying desired output format, including relevant context and constraints, and ensuring the request can be executed precisely without additional clarification - transforming vague instructions into well-defined, comprehensive prompts that guide toward accurate and useful responses',
        concise: 'more concise while preserving meaning',
        professional: 'more formal and professional',
        casual: 'more casual and friendly',
      };

      const styleDesc = styleDescriptions[style] || styleDescriptions.optimized;

      const instructions = [
        `Optimize the following user input to be ${styleDesc}.`,
        maxLength ? `Limit to under ${maxLength} characters.` : undefined,
        'Preserve key details, explicit constraints, and any variable names or code-like identifiers.',
        'Prefer direct, active wording. Remove redundancy and filler. Clarify objectives and constraints when ambiguous.',
        'Do NOT add explanations, labels, prefixes/suffixes, or quotation marks.',
        'Output ONLY the optimized input.',
      ]
        .filter(Boolean)
        .join(' ');

      let result = '';
      await llm.complete(
        modelId,
        [
          {
            role: 'system',
            content: 'You are an expert prompt optimizer who improves user inputs without changing their intent.',
          },
          { role: 'user', content: `${instructions}\n\n---\nOriginal input:\n${text}` },
        ],
        { maxTokens: Math.min(Math.max(Math.ceil((maxLength ?? 400) / 3), 60), 800), temperature: 0.3 },
        async (chunks: (string | null | undefined)[]) => {
          result += chunks.filter(Boolean).join('');
        }
      );

      let optimizedText = (result || '').trim();

      // Sanitize any accidental wrappers or prefixes
      optimizedText = optimizedText
        .replace(/^Rephrased\s*text:\s*/i, '')
        .replace(/^(Enhanced:|Improved:|Optimized:)\s*/i, '')
        .replace(/^"|"$/g, '')
        .replace(/^\'|\'$/g, '')
        .replace(/^`|`$/g, '')
        .trim();

      if (!optimizedText) {
        throw new Error('Failed to generate optimized text');
      }

      const responsePayload: RephraseResponse = {
        optimizedText,
        originalLength: text.length,
        optimizedLength: optimizedText.length,
      };

      return res.json(responsePayload);
    } catch (error) {
      req.logger?.error?.('Optimize Input API error:', error);
      return res.status(500).json({
        error: 'Failed to optimize input. Please try again.',
      });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
