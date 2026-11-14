import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { blockedAtZeroTierLimit } from '@server/middlewares/perUserRateLimit';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { meterCompletionBackend } from '@bike4mind/services';
import { isTerminalCreditRefusal, UnprocessableEntityError } from '@bike4mind/common';
import { createRequestCompletionMeter } from '@bike4mind/server-utils/billing/meterPlatformCompletion';
import { reasoningEffortsFor, reasonsWithinOutputBudget, type ICompletionOptions } from '@bike4mind/llm-adapters';
import type { ModelInfo } from '@bike4mind/common';
import { z } from 'zod';

// 16,000 chars (~4k tokens), matching PROMPT_TEXT_MAX in common. The chat box has no character cap of its
// own (only the model's context window), so this is a server-chosen ceiling; the 800-token output cap
// makes a longer input a lossy rewrite anyway.
const OPTIMIZE_INPUT_MAX_CHARS = 16_000;

// A model that reasons inside its output budget (GPT-5.x, Kimi K3, ...) spends that budget on reasoning
// before any visible text, so the answer-sized cap alone comes back as `length` with an empty reply.
// Sized for the lowest effort; retune from the `stopReason: length` error log if long inputs still end empty.
const REASONING_RESERVE_TOKENS = 2_000;

export function optimizeCompletionOptions(
  modelInfo: ModelInfo,
  maxLength: number | undefined
): Pick<ICompletionOptions, 'maxTokens' | 'temperature' | 'reasoningEffort'> {
  const answerTokens = Math.min(Math.max(Math.ceil((maxLength ?? 400) / 3), 60), 800);
  if (!reasonsWithinOutputBudget(modelInfo)) return { maxTokens: answerTokens, temperature: 0.3 };
  const [lowestEffort] = reasoningEffortsFor(modelInfo);
  return {
    maxTokens: answerTokens + REASONING_RESERVE_TOKENS,
    temperature: 0.3,
    ...(lowestEffort ? { reasoningEffort: lowestEffort } : {}),
  };
}

/** The model finished without any usable text. Carries what the log needs; never the prompt. */
export class EmptyOptimizationError extends Error {
  constructor(
    readonly modelId: string,
    readonly stopReason: string | undefined
  ) {
    super(`Model ${modelId} returned no optimized text (stopReason: ${stopReason ?? 'unknown'})`);
    this.name = 'EmptyOptimizationError';
  }
}

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

    let modelId: string | undefined;
    try {
      const operations = await OperationsModelService.getOperationsModel({ endUserId: req.user.id });
      const { modelInfo } = operations;
      modelId = operations.modelId;
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
      let stopReason: string | undefined;
      await llm.complete(
        modelId,
        [
          {
            role: 'system',
            content: 'You are an expert prompt optimizer who improves user inputs without changing their intent.',
          },
          { role: 'user', content: `${instructions}\n\n---\nOriginal input:\n${text}` },
        ],
        optimizeCompletionOptions(modelInfo, maxLength),
        async (chunks, info) => {
          result += chunks.filter(Boolean).join('');
          if (info?.stopReason) stopReason = info.stopReason;
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
        throw new EmptyOptimizationError(modelId, stopReason);
      }

      const responsePayload: RephraseResponse = {
        optimizedText,
        originalLength: text.length,
        optimizedLength: optimizedText.length,
      };

      return res.json(responsePayload);
    } catch (error) {
      // A credit refusal (422 out of credits, 429 free-tier daily cap) must surface with its own status
      // instead of degrading to a generic 500; the error handler logs it at warn.
      if (error instanceof UnprocessableEntityError || isTerminalCreditRefusal(error)) throw error;
      req.logger?.error?.(
        'Optimize Input API error:',
        {
          modelId: modelId ?? null,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
          stopReason: error instanceof EmptyOptimizationError ? (error.stopReason ?? null) : null,
        },
        new Error(`Optimize input failed on ${modelId ?? 'unresolved model'}`, { cause: error })
      );
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
