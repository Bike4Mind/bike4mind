import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { blockedAtZeroTierLimit } from '@server/middlewares/perUserRateLimit';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { meterCompletionBackend } from '@bike4mind/services';
import { UnprocessableEntityError } from '@bike4mind/common';
import { createRequestCompletionMeter } from '@server/billing/meterPlatformCompletion';
import { z } from 'zod';

// 16,000 chars (~4k tokens), matching PROMPT_TEXT_MAX in common. The chat box has no character cap of its
// own (only the model's context window), so this is a server-chosen ceiling; the 800-token output cap
// makes a longer input a lossy rewrite anyway.
const OPTIMIZE_INPUT_MAX_CHARS = 16_000;

const optimizeInputSchema = z.object({
  text: z.string().max(OPTIMIZE_INPUT_MAX_CHARS).optional(),
  style: z.enum(['optimized', 'concise', 'professional', 'casual']).optional(),
  maxLength: z.number().int().positive().optional(),
});

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

// SPA-only, so it stays off the API-key surface.
const handler = baseApi({ auth: 'jwtOnly' })
  .use(
    rateLimit({
      limit: blockedAtZeroTierLimit(process.env.NODE_ENV === 'development' ? 50 : 20),
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: any, res) => {
    assertAiAccessAllowed(req.user);
    const parsed = optimizeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', '),
      });
    }
    const { text, style = 'optimized', maxLength } = parsed.data;

    if (!text || !text.trim()) {
      return res.status(400).json({
        error: 'Text is required for optimization',
      });
    }

    try {
      const operations = await OperationsModelService.getOperationsModel();
      const { modelId, modelInfo } = operations;
      const llm = meterCompletionBackend(
        operations.llm,
        createRequestCompletionMeter(req, 'prompt optimization', { systemModel: true }),
        modelInfo
      );

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
      // Insufficient credits must surface (422) instead of degrading to a generic 500.
      if (error instanceof UnprocessableEntityError) throw error;
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
