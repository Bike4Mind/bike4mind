/**
 * QuestMaster Tool Schema for GPT-5 Function Calling
 *
 * This module provides the function calling schema and helpers for GPT-5 models
 * to generate structured quest plans. GPT-5 models don't reliably follow the
 * HTML comment format used by other models, so we use OpenAI's function calling
 * feature instead.
 *
 * @see https://platform.openai.com/docs/guides/function-calling
 */

import { ChatModels } from '@bike4mind/common';
import { ICompletionOptionTools } from './llm/backend';

// Length limit constants to prevent oversized data from LLMs.
// Database schema allows up to 2000 for goal and description.
// Exported for use in service schemas to keep limits consistent.
export const MAX_GOAL_LENGTH = 1000;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_TAG_LENGTH = 50;
export const MAX_QUESTS = 20;
export const MAX_SUBQUESTS_PER_QUEST = 20;
export const MAX_TAGS = 10;

/**
 * The result structure returned by the create_quest_plan function call.
 * This matches the structure expected by processQuestPlan() for the JSON path.
 */
export interface QuestPlanFunctionResult {
  goal: string;
  tags?: string[];
  quests: Array<{
    id: string;
    title: string;
    description: string;
    complexity: 'Easy' | 'Medium' | 'Hard';
    subQuests: Array<{
      id: string;
      title: string;
    }>;
  }>;
}

/**
 * GPT-5 models that support function calling (supportsTools: true).
 * Note: *_CHAT_LATEST variants have supportsTools: false and are excluded.
 */
const GPT5_MODELS_WITH_TOOL_SUPPORT: string[] = [
  ChatModels.GPT5,
  ChatModels.GPT5_MINI,
  ChatModels.GPT5_NANO,
  ChatModels.GPT5_1,
  ChatModels.GPT5_2,
  ChatModels.GPT5_4,
  ChatModels.GPT5_4_MINI,
  ChatModels.GPT5_4_NANO,
  ChatModels.GPT5_5,
  ChatModels.GPT5_6_SOL,
  ChatModels.GPT5_6_LUNA,
  ChatModels.GPT5_6_TERRA,
];

/**
 * Check if a model is a GPT-5 variant that supports function calling.
 *
 * @param model - The model ID to check
 * @returns true if the model is GPT-5 with tool support, false otherwise
 */
export function isGPT5ModelWithToolSupport(model: string): boolean {
  return GPT5_MODELS_WITH_TOOL_SUPPORT.includes(model);
}

/**
 * The tool schema for the create_quest_plan function.
 * This schema follows OpenAI's function calling format.
 *
 * We don't use strict: true because it has limitations with nested schemas;
 * the schema is still validated by parseQuestPlanFunctionCall.
 */
export const createQuestPlanToolSchema: ICompletionOptionTools['toolSchema'] = {
  name: 'create_quest_plan',
  description: `Break down a user request into a structured quest plan with actionable tasks.

GUIDELINES:
- Analyze the user's request and create 3-7 main quests
- Each quest must have 2-5 specific, actionable subquests
- Quest titles should be clear and action-oriented
- Provide detailed descriptions for each quest
- Assess complexity accurately: Easy (< 1 hour), Medium (1-4 hours), Hard (> 4 hours)
- Generate 2-5 relevant tags categorizing the work (e.g., "web-development", "database", "api")

TITLE REQUIREMENTS (CRITICAL):
- NEVER use generic titles like "Step 1", "Step 2", "Task 1", "Subtask 1", "Part A"
- ALWAYS use descriptive, action-oriented titles
- Good: "Configure authentication middleware", "Set up database connection pooling"
- Bad: "Step 1", "Subtask 2", "Task A"

HANDLING VERBOSE INPUT:
- Extract the core objective and key requirements from detailed input
- Summarize and structure appropriately rather than incorporating every detail
- Focus on actionable steps

ALWAYS call this function to respond. Do NOT respond with plain text.`,
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The overall objective the user wants to achieve',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Categories for this quest (e.g., "web-development", "api", "database")',
      },
      quests: {
        type: 'array',
        description: 'The main quests (3-7) that break down the goal',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier (e.g., "quest-1", "setup-database")',
            },
            title: {
              type: 'string',
              description: 'Clear, action-oriented title (e.g., "Configure authentication middleware")',
            },
            description: {
              type: 'string',
              description: 'Detailed explanation of what needs to be done and why',
            },
            complexity: {
              type: 'string',
              enum: ['Easy', 'Medium', 'Hard'],
              description: 'Difficulty assessment based on effort required',
            },
            subQuests: {
              type: 'array',
              description: 'Concrete subtasks (2-5) within this quest',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Unique identifier for the subquest',
                  },
                  title: {
                    type: 'string',
                    description: 'Specific, actionable subtask title',
                  },
                },
                required: ['id', 'title'],
              },
            },
          },
          required: ['id', 'title', 'description', 'complexity', 'subQuests'],
        },
      },
    },
    required: ['goal', 'quests'],
  },
};

/**
 * Parse and validate the arguments from a create_quest_plan function call.
 *
 * @param args - The JSON string arguments from the function call
 * @returns The parsed and validated QuestPlanFunctionResult
 * @throws Error if the arguments are invalid or missing required fields
 */
export function parseQuestPlanFunctionCall(args: string): QuestPlanFunctionResult {
  if (!args || typeof args !== 'string' || args.trim() === '') {
    throw new Error('Function call arguments are empty or invalid');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(args);
  } catch (e) {
    throw new Error(`Failed to parse function call arguments as JSON: ${e}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Function call arguments must be an object');
  }

  const result = parsed as Record<string, unknown>;

  if (!result.goal || typeof result.goal !== 'string' || (result.goal as string).trim() === '') {
    throw new Error('Function call missing required field: goal (must be non-empty string)');
  }

  if ((result.goal as string).length > MAX_GOAL_LENGTH) {
    throw new Error(`Goal exceeds maximum length of ${MAX_GOAL_LENGTH} characters`);
  }

  if (!Array.isArray(result.quests)) {
    throw new Error('Function call missing required field: quests (must be an array)');
  }

  if (result.quests.length === 0) {
    throw new Error('Function call returned empty quests array');
  }

  if (result.quests.length > MAX_QUESTS) {
    throw new Error(`Too many quests: ${result.quests.length} (max ${MAX_QUESTS})`);
  }

  // Validate each quest
  for (let i = 0; i < result.quests.length; i++) {
    const quest = result.quests[i];

    if (!quest || typeof quest !== 'object') {
      throw new Error(`Quest ${i} is not a valid object`);
    }

    const questObj = quest as Record<string, unknown>;

    if (!questObj.id || typeof questObj.id !== 'string' || (questObj.id as string).trim() === '') {
      throw new Error(`Quest ${i} missing required field: id (must be non-empty string)`);
    }

    if (!questObj.title || typeof questObj.title !== 'string' || (questObj.title as string).trim() === '') {
      throw new Error(`Quest ${i} missing required field: title (must be non-empty string)`);
    }

    if ((questObj.title as string).length > MAX_TITLE_LENGTH) {
      throw new Error(`Quest ${i} title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`);
    }

    if (
      !questObj.description ||
      typeof questObj.description !== 'string' ||
      (questObj.description as string).trim() === ''
    ) {
      throw new Error(`Quest ${i} missing required field: description (must be non-empty string)`);
    }

    if ((questObj.description as string).length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`Quest ${i} description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`);
    }

    if (!questObj.complexity || !['Easy', 'Medium', 'Hard'].includes(questObj.complexity as string)) {
      throw new Error(`Quest ${i} has invalid complexity: ${questObj.complexity} (must be Easy, Medium, or Hard)`);
    }

    if (!Array.isArray(questObj.subQuests)) {
      throw new Error(`Quest "${questObj.id}" missing required field: subQuests (must be an array)`);
    }

    if (questObj.subQuests.length === 0) {
      throw new Error(`Quest "${questObj.id}" has no subQuests (minimum 2 required)`);
    }

    if (questObj.subQuests.length > MAX_SUBQUESTS_PER_QUEST) {
      throw new Error(
        `Quest "${questObj.id}" has too many subQuests: ${questObj.subQuests.length} (max ${MAX_SUBQUESTS_PER_QUEST})`
      );
    }

    for (let j = 0; j < questObj.subQuests.length; j++) {
      const subQuest = questObj.subQuests[j];

      if (!subQuest || typeof subQuest !== 'object') {
        throw new Error(`Quest "${questObj.id}" subQuest ${j} is not a valid object`);
      }

      const subQuestObj = subQuest as Record<string, unknown>;

      if (!subQuestObj.id || typeof subQuestObj.id !== 'string' || (subQuestObj.id as string).trim() === '') {
        throw new Error(`Quest "${questObj.id}" subQuest ${j} missing required field: id (must be non-empty string)`);
      }

      if (!subQuestObj.title || typeof subQuestObj.title !== 'string' || (subQuestObj.title as string).trim() === '') {
        throw new Error(
          `Quest "${questObj.id}" subQuest ${j} missing required field: title (must be non-empty string)`
        );
      }

      if ((subQuestObj.title as string).length > MAX_TITLE_LENGTH) {
        throw new Error(
          `Quest "${questObj.id}" subQuest ${j} title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`
        );
      }
    }
  }

  // Validate tags if present (must be array of strings)
  if (result.tags !== undefined) {
    if (!Array.isArray(result.tags)) {
      throw new Error('Function call field tags must be an array if provided');
    }

    if (result.tags.length > MAX_TAGS) {
      throw new Error(`Too many tags: ${result.tags.length} (max ${MAX_TAGS})`);
    }

    for (let i = 0; i < result.tags.length; i++) {
      if (typeof result.tags[i] !== 'string') {
        throw new Error(`Function call field tags[${i}] must be a string`);
      }

      if ((result.tags[i] as string).length > MAX_TAG_LENGTH) {
        throw new Error(`Tag ${i} exceeds maximum length of ${MAX_TAG_LENGTH} characters`);
      }
    }
  }

  return result as unknown as QuestPlanFunctionResult;
}
