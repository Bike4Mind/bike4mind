/**
 * Lattice Chat API - Local Development Mode
 *
 * Receives natural language input, calls the LLM with Lattice tool definitions, and
 * returns tool calls for client-side execution. Bypasses EventBridge/QuestProcessor
 * for fast local iteration.
 *
 * Production flow instead goes User -> Chat API -> EventBridge -> QuestProcessor Lambda
 * -> LLM -> Tools -> DB. EventBridge is preferred there: no API Gateway 29s timeout
 * pressure, supports long-running QuestMaster workflows, and has built-in LLM retry.
 * Always prefer the EventBridge pattern for complex/autonomous operations.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import type { ICompletionOptionTools, CompletionInfo } from '@bike4mind/llm-adapters/backend';

// Tool definitions (matching the LLM tool schemas)

// No-op - execution happens client-side (executeTools: false)
const noopToolFn = async () => '';

const LATTICE_TOOLS: ICompletionOptionTools[] = [
  {
    toolFn: noopToolFn,
    toolSchema: {
      name: 'lattice_create_model',
      description: `Create a new Lattice financial model. This is the first step when building a pro-forma or financial analysis.

**When to use:** When the user wants to:
- Create a new financial model, spreadsheet, or pro-forma
- Start building an income statement, balance sheet, or cash flow
- Set up a SaaS metrics dashboard
- Begin any structured numerical analysis

**Model types:**
- income_statement: P&L with revenue, expenses, profits
- balance_sheet: Assets, liabilities, equity
- cashflow: Operating, investing, financing cash flows
- saas_metrics: MRR, ARR, churn, CAC, LTV
- custom: Any other structured model`,
      parameters: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string',
            description: 'Name of the model (e.g., "2024 Budget", "Q1 Forecast")',
          },
          description: {
            type: 'string',
            description: 'Optional description of what this model represents',
          },
          modelType: {
            type: 'string',
            enum: ['income_statement', 'balance_sheet', 'cashflow', 'saas_metrics', 'custom'],
            description: 'Type of financial model to create',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    toolFn: noopToolFn,
    toolSchema: {
      name: 'lattice_add_entity',
      description: `Add a line item, account, period, or other entity to a Lattice model.

**When to use:** When the user mentions:
- Adding a revenue line, expense category, or account
- Creating periods (Q1, Q2, Jan, Feb, etc.)
- Adding any measurable item to their model

**Entity types:**
- line_item: Revenue streams, expense lines, KPIs
- account: Cash, AR, AP, inventory, etc.
- period: Q1 2024, Jan, FY2025, etc.
- category: Groups of line items (Operating Expenses)
- scenario: Base case, upside, downside
- custom: Any other structured element`,
      parameters: {
        type: 'object' as const,
        properties: {
          modelId: {
            type: 'string',
            description: 'ID of the model to add the entity to',
          },
          name: {
            type: 'string',
            description: 'Internal name for the entity (used in formulas)',
          },
          type: {
            type: 'string',
            enum: ['line_item', 'account', 'period', 'category', 'scenario', 'custom'],
            description: 'Type of entity',
          },
          displayName: {
            type: 'string',
            description: 'Human-readable display name (defaults to name)',
          },
          initialValues: {
            type: 'string', // Simplified - complex nested types cause issues
            description: 'JSON array of initial values with key, value, and optional dataType',
          },
        },
        required: ['modelId', 'name', 'type'],
      },
    },
  },
  {
    toolFn: noopToolFn,
    toolSchema: {
      name: 'lattice_set_value',
      description: `Set a specific value in a Lattice model.

**When to use:** When the user provides a specific number:
- "Revenue in Q1 is 150,000"
- "Set marketing spend to 50k for January"

**Important:** This tool is for setting raw input values. For calculated values (formulas), use lattice_create_rule instead.`,
      parameters: {
        type: 'object' as const,
        properties: {
          modelId: {
            type: 'string',
            description: 'ID of the model',
          },
          entityName: {
            type: 'string',
            description: 'Name of the entity (line item, account, etc.)',
          },
          attributeKey: {
            type: 'string',
            description: 'Period or attribute key (e.g., "Q1_2024", "current", "budget")',
          },
          value: {
            type: 'string',
            description: 'The value to set (will be parsed as number if numeric)',
          },
        },
        required: ['modelId', 'entityName', 'attributeKey', 'value'],
      },
    },
  },
  {
    toolFn: noopToolFn,
    toolSchema: {
      name: 'lattice_create_rule',
      description: `Create a formula or calculation rule in a Lattice model.

**IMPORTANT: Use EXACT entity IDs from the model state, not generic names!**

**When to use:** When the user defines a calculation.

**Formula format:** Use exact entity IDs in the format:
  output_entity_id = input_entity_id1 - input_entity_id2

**For per-period calculations:** Create ONE RULE PER PERIOD. Example:
If user says "Gross Margin = Revenue - COGS for each quarter", you must call this tool 4 times:
1. formula: "q1_gross_margin = revenue_q1 - cogs_q1"
2. formula: "q2_gross_margin = revenue_q2 - cogs_q2"
3. formula: "q3_gross_margin = revenue_q3 - cogs_q3"
4. formula: "q4_gross_margin = revenue_q4 - cogs_q4"

**Operations supported:**
- Subtraction: "a = b - c"
- Addition: "a = b + c"
- Multiplication: "a = b * c"
- Division: "a = b / c"`,
      parameters: {
        type: 'object' as const,
        properties: {
          modelId: {
            type: 'string',
            description: 'ID of the model',
          },
          name: {
            type: 'string',
            description: 'Name for this rule (e.g., "Q1 Gross Margin Calculation")',
          },
          description: {
            type: 'string',
            description: 'Optional description of what this rule calculates',
          },
          formula: {
            type: 'string',
            description: 'Formula using EXACT entity IDs: "output_id = input_id1 - input_id2"',
          },
        },
        required: ['modelId', 'name', 'formula'],
      },
    },
  },
];

// System prompt

const LATTICE_SYSTEM_PROMPT_BASE = `You are a financial modeling assistant that helps users create and manipulate Lattice models.

Lattice is a three-layer financial modeling system:
1. **Data Layer**: Entities (line items, accounts, periods) with values
2. **Rules Layer**: Formulas that compute derived values
3. **View Layer**: How data is displayed (tables, charts)

When the user describes a financial model or asks you to create one:
1. First create the model with lattice_create_model
2. Add entities for each line item, category, or period mentioned
3. Set values for any specific numbers provided
4. Create rules for any calculations or formulas described

**CRITICAL: When creating rules, you MUST use the EXACT entity IDs from the model state below.**
Do NOT use generic names like "Revenue" or "COGS". Use the specific IDs like "revenue_q1", "cogs_q2", etc.

**For per-period calculations (e.g., "Gross Margin for each quarter"):**
- Create a SEPARATE rule for EACH period
- Use the exact entity IDs for that period
- Example: If user wants "Gross Margin = Revenue - COGS" for all quarters, create 4 rules:
  - q1_gross_margin = revenue_q1 - cogs_q1
  - q2_gross_margin = revenue_q2 - cogs_q2
  - q3_gross_margin = revenue_q3 - cogs_q3
  - q4_gross_margin = revenue_q4 - cogs_q4`;

/**
 * Format model state for LLM context
 */
function formatModelStateForLLM(modelState: any): string {
  if (!modelState || !modelState.data?.entities) {
    return '\n\n**Current Model State:** No model loaded.';
  }

  const lines: string[] = [
    '',
    '',
    `**Current Model: "${modelState.name}" (ID: ${modelState.id})**`,
    '',
    '**Entities (use these EXACT IDs in formulas):**',
  ];

  const byCategory: Record<string, any[]> = {};

  for (const entity of modelState.data.entities) {
    const categoryAttr = entity.attributes?.find((a: any) => a.key === 'category');
    const category = categoryAttr?.value || 'Other';

    if (!byCategory[category]) {
      byCategory[category] = [];
    }
    byCategory[category].push(entity);
  }

  for (const [category, entities] of Object.entries(byCategory)) {
    lines.push(`\n  ${category}:`);
    for (const entity of entities) {
      const periodAttr = entity.attributes?.find((a: any) => a.key === 'period');
      const valueAttr = entity.attributes?.find((a: any) => a.key === 'value');
      const period = periodAttr?.value || '';
      const value = valueAttr?.value;

      const valueStr = value !== undefined ? ` = ${typeof value === 'number' ? value.toLocaleString() : value}` : '';
      const periodStr = period ? ` [${period}]` : '';

      lines.push(`    - ${entity.id}${periodStr}${valueStr}`);
    }
  }

  if (modelState.rules?.rules?.length > 0) {
    lines.push('');
    lines.push('**Existing Rules:**');
    for (const rule of modelState.rules.rules) {
      lines.push(`  - ${rule.name}: ${rule.description || 'No description'}`);
    }
  }

  return lines.join('\n');
}

const handler = baseApi({ auth: true }).post(
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const logger = new Logger({ metadata: { service: 'LatticeChat' } });
    const {
      message,
      modelState,
      conversationHistory = [],
    } = req.body as {
      message: string;
      modelState?: any; // The full model object for context
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    if (!message || message.trim().length === 0) {
      throw new BadRequestError('Message is required');
    }

    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    let apiKeyTable;
    try {
      apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(user.id, dbAdapters, { logger });
    } catch (error) {
      logger.error('[Lattice Chat] Failed to get API keys:', error);
      throw new BadRequestError('Failed to retrieve API keys. Check server logs.');
    }

    const availableModels = await getAvailableModels(apiKeyTable);
    if (!availableModels || availableModels.length === 0) {
      throw new BadRequestError('No LLM models available. Please configure API keys.');
    }

    // Prefer the newest Claude model that supports tool use, in priority order
    const preferredModels = [ChatModels.CLAUDE_4_6_SONNET, ChatModels.CLAUDE_4_5_SONNET, ChatModels.CLAUDE_4_SONNET];

    let modelInfo = null;
    for (const modelId of preferredModels) {
      modelInfo = availableModels.find(m => m.id === modelId && m.supportsTools);
      if (modelInfo) break;
    }

    // Fallback to any model that supports tools
    if (!modelInfo) {
      modelInfo = availableModels.find(m => m.supportsTools);
    }

    if (!modelInfo) {
      throw new BadRequestError('No LLM models with tool support available.');
    }

    logger.info(`[Lattice Chat] Using model: ${modelInfo.id}`);

    const llm = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: user.id });
    if (!llm) {
      throw new BadRequestError(`Failed to initialize LLM backend for model: ${modelInfo.id}`);
    }

    const modelContext = formatModelStateForLLM(modelState);
    const systemPrompt = LATTICE_SYSTEM_PROMPT_BASE + modelContext;

    logger.info(
      `[Lattice Chat] Model context: ${modelState ? `${modelState.data?.entities?.length || 0} entities` : 'none'}`
    );

    const messages: IMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      {
        role: 'user' as const,
        content: message,
      },
    ];

    try {
      let assistantMessage = '';
      let lastCompletionInfo: CompletionInfo | undefined;

      await llm.complete(
        modelInfo.id,
        messages,
        {
          maxTokens: 4096,
          stream: true,
          tools: LATTICE_TOOLS,
          executeTools: false, // Return tool calls without executing - client will execute
        },
        async (textChunks, completionInfo) => {
          for (const chunk of textChunks) {
            if (chunk && typeof chunk === 'string') {
              assistantMessage += chunk;
            }
          }
          lastCompletionInfo = completionInfo;
        }
      );

      const toolCalls: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      if (lastCompletionInfo?.toolsUsed) {
        for (const tool of lastCompletionInfo.toolsUsed) {
          if (tool.name && tool.arguments) {
            try {
              const input = JSON.parse(tool.arguments);
              toolCalls.push({
                id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: tool.name,
                input,
              });
            } catch (parseError) {
              logger.warn(`[Lattice Chat] Failed to parse tool arguments for ${tool.name}:`, parseError);
            }
          }
        }
      }

      return res.json({
        success: true,
        assistantMessage,
        toolCalls,
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
        model: modelInfo.id,
      });
    } catch (error) {
      logger.error('[Lattice Chat] LLM call failed:', error);
      throw error;
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
