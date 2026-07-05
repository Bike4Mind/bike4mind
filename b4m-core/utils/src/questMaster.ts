import {
  IMessage,
  QuestItem,
  IChatHistoryItemDocument,
  IChatHistoryItemRepository,
  IQuestMasterPlanRepository,
  QuestMasterData,
} from '@bike4mind/common';
import { ICompletionOptions, ICompletionOptionTools, type ICompletionBackend } from './llm';
import { Logger } from '@bike4mind/observability';
import { extractQuestMasterData } from './questMasterUtils';
import {
  isGPT5ModelWithToolSupport,
  createQuestPlanToolSchema,
  parseQuestPlanFunctionCall,
  QuestPlanFunctionResult,
} from './questMasterToolSchema';

export interface IQuestMasterParams {
  model: string;
  options: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    n?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    logitBias?: Record<string, number>;
    stream?: boolean;
  };
  messages: Array<{ role: string; content: string }>;
  sessionId: string;
  message: string;
  historyCount: number;
  fabFileIds: string[];
  user: { id: string; name: string; tags: string[] | null };
}

export interface CreateQuestPlanOptions {
  /** Conversation history to include as context for quest plan generation */
  history?: IMessage[];
}

interface QuestMasterResponse {
  type: 'quest_plan' | 'narrative';
  meta: {
    goal: string;
    totalSteps: number;
    tags?: string[];
  };
  quests: QuestMasterData[];
}

/**
 * Sanitize IDs to only contain alphanumeric characters, hyphens, and underscores.
 * This ensures IDs pass API validation regex /^[a-zA-Z0-9_.-]+$/
 * LLMs often generate IDs with dots, spaces, or other characters that need sanitizing.
 *
 * @param id - The ID to sanitize
 * @param fallback - Fallback ID to use if sanitization results in empty string
 * @returns Sanitized ID or fallback if result would be empty
 */
const sanitizeId = (id: string, fallback: string): string => {
  const sanitized = id
    .replace(/\s+/g, '-') // Replace whitespace with hyphens
    .replace(/[^a-zA-Z0-9_.-]/g, '') // Remove invalid chars (keep dots for backward compat)
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  return sanitized || fallback;
};

export class QuestMaster {
  constructor(
    private readonly llm: ICompletionBackend,
    private readonly db: {
      quests: IChatHistoryItemRepository;
      questMasterPlans: IQuestMasterPlanRepository;
    },
    private readonly onStatusUpdate: (quest: IChatHistoryItemDocument, status: string | null) => Promise<void>,
    private readonly quest: IChatHistoryItemDocument | null,
    private readonly logger: Logger,
    private readonly userId: string
  ) {}

  private determineComplexity(details: string | undefined): string {
    if (!details) return 'Medium'; // Default to Medium if no details provided

    const lowercaseDetails = details.toLowerCase();
    if (
      lowercaseDetails.includes('complex') ||
      lowercaseDetails.includes('challenging') ||
      lowercaseDetails.includes('difficult')
    ) {
      return 'Hard';
    } else if (lowercaseDetails.includes('moderate') || lowercaseDetails.includes('intermediate')) {
      return 'Medium';
    }
    return 'Easy';
  }

  public async processQuestPlan(input: string | QuestPlanFunctionResult): Promise<void> {
    try {
      if (!this.quest) {
        throw new Error('No quest context available');
      }

      await this.onStatusUpdate(this.quest, 'Step 2/4: Organizing quests and sub-tasks...');

      // Default response structure for error cases
      const defaultResponse: QuestMasterResponse = {
        type: 'narrative',
        meta: {
          goal: 'Error Processing Quest',
          totalSteps: 1,
        },
        quests: [
          {
            id: 'error-quest',
            title: 'Error Processing Quest',
            description: 'An error occurred while processing the quest plan.',
            complexity: 'Medium',
            subQuests: [],
          },
        ],
      };

      let questResponse: QuestMasterResponse;

      // Handle QuestPlanFunctionResult (from GPT-5 function calling) directly
      // typeof null === 'object' in JS, so we must check for null explicitly
      if (input !== null && typeof input === 'object') {
        this.logger.log('Processing quest plan from function calling result');

        questResponse = {
          type: 'quest_plan',
          meta: {
            goal: input.goal,
            totalSteps: input.quests.length,
            tags: input.tags,
          },
          quests: input.quests.map(quest => ({
            id: quest.id,
            title: quest.title,
            description: quest.description,
            complexity: quest.complexity,
            status: 'not_started',
            subQuests: quest.subQuests.map(sub => ({
              id: sub.id,
              title: sub.title,
              status: 'not_started',
            })),
          })),
        };
      } else {
        // Handle string input (HTML comment format from other models)
        const questPlanText = input;
        this.logger.log('Processing quest plan:', questPlanText);

        if (!questPlanText || typeof questPlanText !== 'string') {
          this.logger.warn('Invalid questPlanText received:', questPlanText);
          if (this.quest) {
            this.quest.questMasterReply = JSON.stringify(defaultResponse);
            await this.db.quests.update({
              id: this.quest.id,
              questMasterReply: this.quest.questMasterReply,
              reply: null,
              replies: [],
              status: 'done',
              type: 'message',
            });
          }
          return;
        }

        // Extract QuestMaster data from HTML comments
        const extracted = extractQuestMasterData(questPlanText, { logger: this.logger });

        const metaStartTag = '<!--QuestMasterMeta';
        const metaEndTag = '-->';
        const metaStartIndex = questPlanText.indexOf(metaStartTag);
        let goal = 'Quest Plan';
        let tags: string[] = [];

        if (metaStartIndex !== -1) {
          const metaEndIndex = questPlanText.indexOf(metaEndTag, metaStartIndex);
          if (metaEndIndex !== -1) {
            const metaContent = questPlanText.slice(metaStartIndex + metaStartTag.length, metaEndIndex).trim();
            try {
              const jsonStartIndex = metaContent.indexOf('{');
              if (jsonStartIndex !== -1) {
                const metaData = JSON.parse(metaContent.slice(jsonStartIndex));
                goal = metaData.goal || goal;
                tags = Array.isArray(metaData.tags) ? metaData.tags : [];
              }
            } catch (err) {
              this.logger.error('Error parsing meta data:', err);
            }
          }
        }

        if (extracted.length > 0) {
          this.logger.log('Successfully extracted QuestMaster data:', extracted);
          await this.onStatusUpdate(this.quest, 'Step 3/4: Validating quest structure...');

          // Validate basic quest structure - quests must have id, title, and description
          // Title content is not filtered; LLM prompts guide better title generation
          const validQuests = extracted.filter(
            quest => quest !== null && typeof quest === 'object' && quest.id && quest.title && quest.description
          );

          // If we have no valid quests after filtering, throw an error to trigger retry
          if (validQuests.length === 0) {
            throw new Error('No valid quests found after filtering');
          }

          questResponse = {
            type: 'quest_plan',
            meta: {
              goal,
              totalSteps: validQuests.length,
              tags,
            },
            quests: validQuests.map(quest => ({
              id: quest.id, // No fallback - we filtered for valid IDs
              title: quest.title, // No fallback - we filtered for valid titles
              description: quest.description, // No fallback - we filtered for valid descriptions
              complexity: quest.complexity || 'Medium',
              status: 'not_started',
              // Validate basic subquest structure - must have id and title
              subQuests: Array.isArray(quest.subQuests)
                ? quest.subQuests
                    .filter(sub => sub && sub.id && sub.title)
                    .map(sub => ({
                      id: sub.id,
                      title: sub.title,
                      status: 'not_started',
                    }))
                : [],
            })),
          };

          // If any quest has no subquests after filtering, throw error to trigger retry
          if (questResponse.quests.some(quest => quest.subQuests.length === 0)) {
            throw new Error('Some quests have no valid subquests after filtering');
          }
        } else {
          // Try to parse as raw JSON if no HTML comments found
          try {
            const questPlan = JSON.parse(questPlanText);
            if (questPlan && questPlan.questChain && Array.isArray(questPlan.questChain)) {
              // Validate basic quest structure - must have quest title and details
              const validQuestChain = questPlan.questChain.filter(
                (item: QuestItem) => item && item.quest && item.details
              );

              if (validQuestChain.length === 0) {
                throw new Error('No valid quests found in quest chain');
              }

              questResponse = {
                type: 'quest_plan',
                meta: {
                  goal: questPlan.abstractObjective || 'Process Request',
                  totalSteps: validQuestChain.length,
                },
                quests: validQuestChain.map((item: QuestItem, index: number) => ({
                  id: `quest-${index + 1}`,
                  title: item.quest,
                  description: item.details,
                  complexity: this.determineComplexity(item.details),
                  status: 'not_started',
                  subQuests: [], // This will trigger a retry since we require subquests
                })),
              };
            } else {
              // Only create narrative response for non-empty content
              if (!questPlanText.trim()) {
                throw new Error('Empty response received');
              }
              // Accept any non-empty response

              questResponse = {
                type: 'narrative',
                meta: {
                  goal: 'Direct Response',
                  totalSteps: 1,
                },
                quests: [
                  {
                    id: 'narrative-1',
                    title: 'Process Response',
                    description: questPlanText.trim(),
                    complexity: 'Medium',
                    subQuests: [
                      {
                        id: 'narrative-1-1',
                        title: 'Review Response',
                        status: 'not_started',
                      },
                    ],
                  },
                ],
              };
            }
          } catch (parseError) {
            this.logger.error('Error parsing quest plan JSON:', parseError);
            questResponse = defaultResponse;
          }
        }
      }

      if (!this.validateQuestResponse(questResponse)) {
        questResponse = defaultResponse;
        this.logger.error('Invalid quest response structure, using default');
      }

      await this.onStatusUpdate(this.quest, 'Step 4/4: Saving quest plan...');

      Logger.globalInstance.log('🎯 Creating QuestMasterPlan with userId:', this.userId);

      const questMasterPlan = await this.db.questMasterPlans.create({
        notebookId: this.quest.sessionId,
        goal: questResponse.meta.goal,
        userId: this.userId,
        tags: questResponse.meta.tags || [],
        quests: questResponse.quests.map((quest, questIndex) => {
          const questId = sanitizeId(quest.id, `quest-${questIndex + 1}`);
          return {
            id: questId,
            title: quest.title,
            description: quest.description,
            complexity: quest.complexity,
            subQuests: quest.subQuests.map((sub, subIndex) => ({
              id: sanitizeId(sub.id, `${questId}-sub-${subIndex + 1}`),
              title: sub.title,
              status: sub.status as 'not_started' | 'in_progress' | 'completed' | 'deleted',
              // questId intentionally omitted - will be set when task is started and linked to a chat message
            })),
          };
        }),
      });

      this.quest.questMasterPlanId = questMasterPlan.id;
      this.quest.reply = null;
      this.quest.replies = [];
      this.quest.status = 'done';
      this.quest.type = 'message';

      await this.db.quests.update({
        id: this.quest.id,
        questMasterPlanId: this.quest.questMasterPlanId,
        reply: this.quest.reply,
        replies: this.quest.replies,
        status: this.quest.status,
        type: this.quest.type,
      });
      this.logger.log('Successfully processed quest with response:', questResponse);
    } catch (error) {
      this.logger.error('Error in processing quest plan:', error);
      if (this.quest) {
        const errorResponse: QuestMasterResponse = {
          type: 'narrative',
          meta: {
            goal: 'Error Processing Quest',
            totalSteps: 1,
          },
          quests: [
            {
              id: 'error-quest',
              title: 'Error Processing Quest',
              description: error instanceof Error ? error.message : String(error),
              complexity: 'Medium',
              subQuests: [],
            },
          ],
        };

        this.quest.questMasterReply = JSON.stringify(errorResponse);
        this.quest.reply = null;
        this.quest.replies = [];
        this.quest.status = 'done';
        this.quest.type = 'error';
        await this.db.quests.update({
          id: this.quest.id,
          questMasterReply: this.quest.questMasterReply,
          reply: this.quest.reply,
          replies: this.quest.replies,
          status: this.quest.status,
          type: this.quest.type,
        });
      }
      throw error;
    } finally {
      if (this.quest) {
        await this.onStatusUpdate(this.quest, null);
      }
    }
  }

  private validateQuestResponse(response: QuestMasterResponse): boolean {
    try {
      if (!response || typeof response !== 'object') return false;
      if (!['quest_plan', 'narrative'].includes(response.type)) return false;
      if (!response.meta?.goal || typeof response.meta.goal !== 'string') return false;
      if (!Array.isArray(response.quests) || response.quests.length === 0) return false;

      for (const quest of response.quests) {
        if (!quest.id || !quest.title || !quest.description) return false;
        if (!quest.complexity || !['Easy', 'Medium', 'Hard'].includes(quest.complexity)) return false;
        if (!Array.isArray(quest.subQuests)) return false;

        for (const subQuest of quest.subQuests) {
          if (!subQuest.id || !subQuest.title || !subQuest.status) return false;
        }
      }

      return true;
    } catch (error) {
      this.logger.error('Error validating quest response:', error);
      return false;
    }
  }

  private convertToQuestMasterFormat(jsonData: any, prompt: string): string {
    // Extract goal from various possible fields
    const goal = jsonData.goal || jsonData.objective || jsonData.title || prompt.substring(0, 50) + '...';

    // Extract quests from various possible structures
    let quests = [];
    if (Array.isArray(jsonData.quests)) {
      quests = jsonData.quests;
    } else if (Array.isArray(jsonData.questChain)) {
      quests = jsonData.questChain;
    } else if (Array.isArray(jsonData.tasks)) {
      quests = jsonData.tasks;
    } else if (jsonData.plan && Array.isArray(jsonData.plan)) {
      quests = jsonData.plan;
    }

    let formattedResponse = `<!--QuestMasterMeta
{
  "type": "quest_plan",
  "goal": "${goal}",
  "totalSteps": ${quests.length || 1}
}
-->`;

    quests.forEach((quest: any, index: number) => {
      const questId = quest.id || `quest-${index + 1}`;
      const questTitle = quest.title || quest.quest || quest.name || `Task ${index + 1}`;
      const questDescription = quest.description || quest.details || quest.content || questTitle;
      const questComplexity = quest.complexity || 'Medium';

      // Extract or generate subquests
      let subQuests = [];
      if (Array.isArray(quest.subQuests)) {
        subQuests = quest.subQuests;
      } else if (Array.isArray(quest.subtasks)) {
        subQuests = quest.subtasks;
      } else if (Array.isArray(quest.steps)) {
        subQuests = quest.steps;
      } else {
        // Generate default subquests if none exist
        subQuests = [
          { id: `${questId}-1`, title: `Prepare for ${questTitle}`, status: 'not_started' },
          { id: `${questId}-2`, title: `Execute ${questTitle}`, status: 'not_started' },
          { id: `${questId}-3`, title: `Verify ${questTitle}`, status: 'not_started' },
        ];
      }

      formattedResponse += `
<!--QuestMaster
{
  "id": "${questId}",
  "title": "${questTitle}",
  "description": "${questDescription}",
  "complexity": "${questComplexity}",
  "status": "Not Started",
  "subQuests": ${JSON.stringify(
    subQuests.map((sub: any, subIndex: number) => ({
      id: sub.id || `${questId}-${subIndex + 1}`,
      title: sub.title || sub.name || `Subtask ${subIndex + 1}`,
      status: sub.status || 'Not Started',
    })),
    null,
    2
  )
    .split('\n')
    .map(line => '    ' + line)
    .join('\n')
    .trim()}
}
-->`;
    });

    return formattedResponse;
  }

  private createSimpleQuestFromText(text: string, prompt: string): string {
    // Create a simple quest structure from plain text
    const goal = prompt.substring(0, 100);
    const questId = 'quest-1';

    return `<!--QuestMasterMeta
{
  "type": "quest_plan",
  "goal": "${goal}",
  "totalSteps": 1
}
-->
<!--QuestMaster
{
  "id": "${questId}",
  "title": "Process Request",
  "description": "${text.substring(0, 1000).replace(/"/g, '\\"')}",
  "complexity": "Medium",
  "status": "Not Started",
  "subQuests": [
    {
      "id": "${questId}-1",
      "title": "Analyze request",
      "status": "Not Started"
    },
    {
      "id": "${questId}-2",
      "title": "Execute solution",
      "status": "Not Started"
    },
    {
      "id": "${questId}-3",
      "title": "Verify results",
      "status": "Not Started"
    }
  ]
}
-->`;
  }

  /**
   * Create a quest plan using GPT-5's function calling feature.
   * This method is used when the model is a GPT-5 variant that supports tools
   * but doesn't reliably follow HTML comment formatting.
   *
   * @param model - The GPT-5 model to use
   * @param prompt - The user's request to break down into quests
   * @returns The parsed quest plan result
   */
  private async createQuestPlanWithFunctionCalling(
    model: string,
    prompt: string,
    planOptions: CreateQuestPlanOptions = {},
    retryCount = 0
  ): Promise<QuestPlanFunctionResult> {
    const MAX_RETRIES = 2;
    const { history = [] } = planOptions;

    const hasHistory = history.length > 0;
    const historyContext = hasHistory
      ? `

CONVERSATION CONTEXT:
You have access to the user's conversation history. Use this context to:
- Understand what the user has already discussed or learned
- Reference previous decisions or preferences mentioned
- Build upon prior context when creating quests
- Avoid suggesting steps the user has already completed

The conversation history is included before the user's current request.`
      : '';

    const messages: IMessage[] = [
      {
        role: 'system',
        content: `You are the QuestMaster, an AI agent that breaks down complex tasks into manageable quests.

When given a user request, you MUST call the create_quest_plan function to structure your response.
Do NOT respond with plain text - ALWAYS use the function call.

Guidelines:
- Break down complex tasks into 3-7 main quests
- Each quest needs 2-5 specific, actionable subquests
- Make titles clear and action-oriented
- Provide detailed descriptions explaining what needs to be done
- Assess complexity accurately: Easy (< 1 hour), Medium (1-4 hours), Hard (> 4 hours)
- Generate 2-5 relevant tags categorizing the work

TITLE REQUIREMENTS (CRITICAL):
- NEVER use generic titles like "Step 1", "Step 2", "Task 1", "Subtask 1", "Part A"
- ALWAYS use descriptive, action-oriented titles that explain what the step accomplishes
- Good examples: "Configure authentication middleware", "Set up database connection pooling"
- Bad examples: "Step 1", "Subtask 2", "Task A", "Part 1"

HANDLING VERBOSE INPUT:
- When given detailed or verbose input, extract the core objective and key requirements
- Do not try to incorporate every detail verbatim - summarize and structure appropriately
- Focus on actionable steps rather than preserving all user context${historyContext}`,
      },
      // Include conversation history BEFORE the current user request
      ...history,
      { role: 'user', content: prompt },
    ];

    const toolDef: ICompletionOptionTools = {
      toolFn: async params => JSON.stringify(params), // Not executed, just captured
      toolSchema: createQuestPlanToolSchema,
    };

    const completionOptions: Partial<ICompletionOptions> = {
      temperature: retryCount > 0 ? 0.5 : 0.7, // Lower temperature for structured JSON outputs; even lower on retries
      n: 1,
      stream: false,
      tools: [toolDef],
      executeTools: false, // Don't execute, just capture the function call
      tool_choice: { type: 'function', function: { name: 'create_quest_plan' } }, // Force function call
      parallel_tool_calls: false, // Required for structured outputs
    };

    let functionResult: QuestPlanFunctionResult | null = null;
    let lastError: Error | null = null;

    try {
      await this.llm.complete(model, messages, completionOptions, async (text, completionInfo) => {
        if (completionInfo?.toolsUsed?.length) {
          const toolCall = completionInfo.toolsUsed[0];
          if (toolCall.name === 'create_quest_plan' && toolCall.arguments) {
            this.logger.log('GPT-5 function call received, parsing arguments...');
            try {
              functionResult = parseQuestPlanFunctionCall(toolCall.arguments);
            } catch (parseError) {
              lastError = parseError instanceof Error ? parseError : new Error(String(parseError));
              this.logger.error('Failed to parse function call arguments:', parseError);
            }
          }
        }
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Error in GPT-5 function calling:', lastError);
    }

    // If no function result, retry or throw
    if (!functionResult) {
      if (retryCount < MAX_RETRIES) {
        this.logger.warn(`GPT-5 did not return function call, retrying (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
        return this.createQuestPlanWithFunctionCalling(model, prompt, planOptions, retryCount + 1);
      }
      throw lastError || new Error('GPT-5 did not call create_quest_plan function after retries');
    }

    // At this point functionResult is guaranteed to be non-null
    const result: QuestPlanFunctionResult = functionResult;

    // Validate that quests have subquests
    const questsWithoutSubquests = result.quests.filter(
      (q: QuestPlanFunctionResult['quests'][0]) => !q.subQuests || q.subQuests.length === 0
    );

    if (questsWithoutSubquests.length > 0) {
      if (retryCount < MAX_RETRIES) {
        this.logger.warn(
          `Some quests missing subquests: ${questsWithoutSubquests.map((q: QuestPlanFunctionResult['quests'][0]) => q.id).join(', ')}, retrying...`
        );
        return this.createQuestPlanWithFunctionCalling(model, prompt, planOptions, retryCount + 1);
      } else {
        // Log warning when returning incomplete data after max retries
        this.logger.warn(
          `Returning quest plan with ${questsWithoutSubquests.length} quests missing subquests after max retries (${MAX_RETRIES}): ${questsWithoutSubquests.map((q: QuestPlanFunctionResult['quests'][0]) => q.id).join(', ')}`
        );
      }
    }

    this.logger.log('Successfully received GPT-5 function call result:', {
      goal: result.goal,
      questCount: result.quests.length,
      tags: result.tags,
    });

    return result;
  }

  public async createQuestPlan(
    model: string,
    prompt: string,
    options: CreateQuestPlanOptions = {}
  ): Promise<string | void> {
    try {
      if (!this.quest) {
        throw new Error('No quest context available');
      }

      const { history = [] } = options;
      this.logger.log(`Creating quest plan with ${history.length} history messages for context`);

      await this.onStatusUpdate(this.quest, 'Step 1/4: Analyzing your request...');

      // Use function calling for GPT-5 models that support tools
      if (isGPT5ModelWithToolSupport(model)) {
        this.logger.log(`Using function calling approach for GPT-5 model: ${model}`);
        try {
          const result = await this.createQuestPlanWithFunctionCalling(model, prompt, options);
          // Process the result directly (JSON path)
          await this.processQuestPlan(result);
          return; // processQuestPlan handles saving to DB
        } catch (functionCallError) {
          this.logger.error('Function calling failed, falling back to HTML approach:', functionCallError);
          // Fall through to HTML comment approach as fallback
        }
      }

      // Original HTML comment approach for other models (or as fallback)
      const hasHistory = history.length > 0;
      const historyContext = hasHistory
        ? `

CONVERSATION CONTEXT:
You have access to the user's conversation history. Use this context to:
- Understand what the user has already discussed or learned
- Reference previous decisions or preferences mentioned
- Build upon prior context when creating quests
- Avoid suggesting steps the user has already completed

The conversation history is included before the user's current request.`
        : '';

      const messages: IMessage[] = [
        {
          role: 'system',
          content: `You are the QuestMaster, an advanced AI agent designed to break down complex tasks into manageable subtasks.

Your primary role is to analyze user requests and create structured quest plans. You must ALWAYS follow this exact format:

<!--QuestMasterMeta
{
  "type": "quest_plan",
  "goal": "Extract and state the user's overall goal here",
  "totalSteps": number_of_quests,
  "tags": ["tag1", "tag2", "tag3"]
}
-->

For each quest in the plan:
<!--QuestMaster
{
  "id": "unique_id",
  "title": "Clear, action-oriented title",
  "description": "Detailed explanation of what needs to be done",
  "complexity": "Easy|Medium|Hard",
  "status": "Not Started",
  "subQuests": [
    {
      "id": "sub_unique_id",
      "title": "Clear, specific subquest title",
      "status": "Not Started"
    }
  ]
}
-->

IMPORTANT GUIDELINES:
1. ALWAYS start with QuestMasterMeta containing the overall goal
2. Break down complex tasks into 3-7 main quests
3. Make quest titles clear and actionable
4. Provide detailed descriptions
5. Assess complexity accurately
6. ALWAYS include relevant subquests - do not create empty subQuests arrays
7. Maintain exact JSON structure
8. No text between comment tags and JSON
9. Each quest should have 2-5 concrete subquests that break down the work
10. Generate 2-5 relevant tags that categorize this quest (e.g., "web-development", "react", "database", "ui-design", "api", "testing", "documentation")

TITLE REQUIREMENTS (CRITICAL):
- NEVER use generic titles like "Step 1", "Step 2", "Task 1", "Subtask 1", "Part A"
- ALWAYS use descriptive, action-oriented titles that explain what the step accomplishes
- Good examples: "Configure authentication middleware", "Set up database connection pooling"
- Bad examples: "Step 1", "Subtask 2", "Task A", "Part 1"

HANDLING VERBOSE INPUT:
- When given detailed or verbose input, extract the core objective and key requirements
- Do not try to incorporate every detail verbatim - summarize and structure appropriately
- Focus on actionable steps rather than preserving all user context

Remember:
- The goal field in QuestMasterMeta is crucial for UI display
- Each quest and subquest must have a unique, descriptive ID
- Keep JSON properly formatted
- The client UI depends on this exact structure
- Never return a response without proper subquests${historyContext}`,
        },
        // Include conversation history BEFORE the current user request
        ...history,
        { role: 'user', content: prompt },
      ];

      const completionOptions: Partial<ICompletionOptions> = {
        temperature: 0.9,
        n: 1,
        stream: false,
      };

      const tryGenerateQuestPlan = async (
        currentMessages: IMessage[],
        currentOptions: Partial<ICompletionOptions>,
        retryCount = 0
      ) => {
        if (retryCount > 0) {
          this.logger.log('Retrying quest plan generation', retryCount);
        }

        try {
          let response: string = '';

          await this.llm.complete(model, currentMessages, currentOptions, async text => {
            response = text.filter((t): t is string => t !== null && t !== undefined).join('\n');
            response = response.replace(/^```json\n/, '').replace(/\n```$/, '');
          });

          // Check for the meta tag
          if (!response.includes('<!--QuestMasterMeta')) {
            this.logger.warn('Response missing QuestMasterMeta section. Response preview:', response.substring(0, 500));

            // Try to recover by adding a default meta section if we have quest data
            if (response.includes('<!--QuestMaster')) {
              const defaultMeta = `<!--QuestMasterMeta
{
  "type": "quest_plan",
  "goal": "Process user request",
  "totalSteps": 3
}
-->`;
              response = defaultMeta + '\n' + response;
              this.logger.info('Added default QuestMasterMeta section to recover from missing meta');
            } else {
              // Check if the response might be in a different format (e.g., plain JSON or markdown)
              try {
                const jsonData = JSON.parse(response);
                if (jsonData && (jsonData.quests || jsonData.questChain || jsonData.tasks)) {
                  const convertedResponse = this.convertToQuestMasterFormat(jsonData, prompt);
                  this.logger.info('Converted non-standard format to QuestMaster format');
                  response = convertedResponse;
                } else {
                  throw new Error('Response format not recognized');
                }
              } catch (jsonError) {
                // If not JSON, check if it's a meaningful text response
                if (response.length > 50 && !response.includes('Error') && !response.includes('error')) {
                  // Create a simple quest from the text response
                  const simpleQuest = this.createSimpleQuestFromText(response, prompt);
                  this.logger.info('Created simple quest from text response');
                  response = simpleQuest;
                } else {
                  // Only throw if we really can't recover
                  this.logger.error(
                    'Unable to recover from missing QuestMasterMeta. Response:',
                    response.substring(0, 200)
                  );
                  throw new Error('Missing QuestMasterMeta section and no quest data found');
                }
              }
            }
          }

          // Extract all quest data including meta
          const extracted = extractQuestMasterData(response, { logger: this.logger });

          if (extracted.length === 0) {
            throw new Error('No valid QuestMaster data found');
          }

          // Count quests with missing subquests
          const questsWithoutSubquests = extracted
            .filter(quest => quest !== null && typeof quest === 'object') // Filter out null/invalid quests
            .filter(quest => !quest.subQuests || quest.subQuests.length === 0);

          if (questsWithoutSubquests.length > 0) {
            this.logger.warn(
              'Found quests without subquests:',
              questsWithoutSubquests.map(q => q.id)
            );

            // Only retry if we actually found valid quests that are missing subquests
            if (questsWithoutSubquests.some(q => q.id && q.title)) {
              // Retry with more specific instructions about the problematic quests
              const retryMessages: IMessage[] = [
                ...currentMessages,
                {
                  role: 'assistant' as const,
                  content: response,
                },
                {
                  role: 'user' as const,
                  content: `The following quests need specific subquests: ${questsWithoutSubquests
                    .map(q => q.title)
                    .join(
                      ', '
                    )}. Please provide 2-5 concrete subquests for each of these quests while keeping the existing structure.`,
                },
              ];

              // Retry with lower temperature
              const retryOptions = {
                ...currentOptions,
                temperature: Math.max(0.5, (currentOptions.temperature ?? 0.9) - 0.2),
              };

              // Recursive retry with updated count
              return tryGenerateQuestPlan(retryMessages, retryOptions, retryCount + 1);
            }
          }

          // All valid quests have subquests
          return response;
        } catch (error) {
          if (retryCount >= 2) {
            throw error;
          }

          // First attempt failed, retry with more explicit prompt
          const retryMessages: IMessage[] = [
            currentMessages[0],
            { role: 'user' as const, content: prompt },
            {
              role: 'assistant' as const,
              content: 'I need to break this down into specific quests with subquests. Let me try again.',
            },
            {
              role: 'user' as const,
              content:
                'Please break down this request into specific quests and subquests following the exact format. Each quest must have 2-5 concrete subquests.',
            },
          ];

          const retryOptions = {
            ...currentOptions,
            temperature: Math.max(0.5, (currentOptions.temperature ?? 0.9) - 0.2),
          };

          // Recursive retry with updated count
          return tryGenerateQuestPlan(retryMessages, retryOptions, retryCount + 1);
        }
      };

      return await tryGenerateQuestPlan(messages, completionOptions);
    } catch (error) {
      this.logger.error('Error in createQuestPlan:', error);
      throw error;
    }
  }
}

export default QuestMaster;
