import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { substitutePromptVariables } from '@server/utils/systemPrompts/defaults';
import { z } from 'zod';

/**
 * Request schema for testing a system prompt
 */
const TestPromptRequestSchema = z.object({
  /** The prompt content to test (current editor state) */
  content: z.string().min(1),

  /** Sample variable values for substitution */
  variables: z
    .record(z.string(), z.union([z.string(), z.record(z.string(), z.unknown())]))
    .optional()
    .transform(vars => {
      if (!vars) return {};
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined || value === null) {
          result[key] = '';
        } else if (typeof value === 'object') {
          result[key] = JSON.stringify(value, null, 2);
        } else {
          result[key] = String(value);
        }
      }
      return result;
    }),

  /** Whether to actually call LLM */
  executeWithLLM: z.boolean().optional().default(false),
});

/**
 * Estimate token count using simple heuristic (4 chars per token average)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Find unfilled variables in content
 */
function findUnfilledVariables(content: string, providedVariables: Record<string, string>): string[] {
  const variablePattern = /\{\{(\w+)\}\}/g;
  const unfilled: string[] = [];
  let match;

  while ((match = variablePattern.exec(content)) !== null) {
    const varName = match[1];
    if (!providedVariables[varName]) {
      unfilled.push(varName);
    }
  }

  return Array.from(new Set(unfilled));
}

/**
 * POST /api/admin/system-prompts/[promptId]/test
 * Test a system prompt with variable substitution. Returns a substitution
 * preview and token estimate; does not execute the LLM.
 */
const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  try {
    const validated = TestPromptRequestSchema.parse(req.body);
    const { content, variables = {} } = validated;

    // Substitute variables
    const renderedContent = substitutePromptVariables(content, variables);

    // Find unfilled variables
    const unfilledVariables = findUnfilledVariables(content, variables);

    return res.json({
      success: true,
      data: {
        renderedContent,
        unfilledVariables,
        estimatedTokens: estimateTokens(renderedContent),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: error.issues,
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to test prompt',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
