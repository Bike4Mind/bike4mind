import { SQSService } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { SlackClient } from '../SlackClient';
import { ChatModels, IChatHistoryItem, IUserDocument } from '@bike4mind/common';
import { ChatCompletionInvoke } from '@bike4mind/services';
import { getSlackDeps, getSlackDb } from '../di/registry';

/**
 * Workflow step callback IDs - must match the app manifest
 */
export const WORKFLOW_STEP_CALLBACKS = {
  CREATE_NOTEBOOK: 'b4m_create_notebook',
  SEND_MESSAGE: 'b4m_send_message',
  QUERY: 'b4m_query',
} as const;

/**
 * Input structure for the function_executed event
 */
export interface FunctionExecutedEvent {
  type: 'function_executed';
  function: {
    id: string;
    callback_id: string;
    title: string;
    description?: string;
    type: string;
    app_id: string;
  };
  inputs: Record<string, unknown>;
  function_execution_id: string;
  workflow_execution_id: string;
  event_ts: string;
  bot_access_token?: string;
}

/**
 * Typed input interfaces for each workflow step
 */
interface CreateNotebookInputs {
  user_id: string;
  notebook_name?: string;
  send_notification?: boolean;
}

interface SendMessageInputs {
  user_id: string;
  message: string;
  notebook_id?: string;
  wait_for_response?: boolean;
  send_notification?: boolean;
}

interface QueryInputs {
  user_id: string;
  query: string;
  notebook_id?: string;
  send_notification?: boolean;
}

/**
 * Discriminated union for workflow step results
 * Success and failure are mutually exclusive states
 */
type WorkflowStepResult =
  | {
      success: true;
      outputs: Record<string, unknown>;
      /** Message to send as DM notification */
      notificationMessage?: string;
      /** Slack user ID to send notification to */
      slackUserId?: string;
    }
  | {
      success: false;
      error: string;
    };

/**
 * WorkflowStepHandler processes B4M workflow step executions
 * Supports: Create Notebook, Send to B4M, Query B4M
 */
export class WorkflowStepHandler {
  private logger: Logger;
  private slackClient: SlackClient;

  constructor(slackClient: SlackClient, logger: Logger) {
    this.slackClient = slackClient;
    this.logger = logger;
  }

  /**
   * Handle a function_executed event by routing to the appropriate step handler
   */
  async handleFunctionExecuted(event: FunctionExecutedEvent): Promise<void> {
    const startTime = Date.now();
    const { function: func, inputs, function_execution_id } = event;
    const callbackId = func?.callback_id;

    // Validate required event IDs before processing
    if (!function_execution_id?.trim()) {
      this.logger.error('[WorkflowStep] Invalid event: missing function_execution_id', {
        hasFunc: !!func,
        hasInputs: !!inputs,
      });
      return;
    }

    if (!callbackId?.trim()) {
      this.logger.error('[WorkflowStep] Invalid event: missing callback_id', {
        functionExecutionId: function_execution_id,
      });
      // Report error to Slack so workflow doesn't hang
      await this.slackClient.functionCompleteError(function_execution_id, 'Invalid workflow step: missing callback_id');
      return;
    }

    try {
      let result: WorkflowStepResult;

      switch (callbackId) {
        case WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK:
          // Inputs validated inside handler; cast via unknown for type safety
          result = await this.handleCreateNotebook(inputs as unknown as CreateNotebookInputs);
          break;
        case WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE:
          // Inputs validated inside handler; cast via unknown for type safety
          result = await this.handleSendMessage(inputs as unknown as SendMessageInputs);
          break;
        case WORKFLOW_STEP_CALLBACKS.QUERY:
          // Inputs validated inside handler; cast via unknown for type safety
          result = await this.handleQuery(inputs as unknown as QueryInputs);
          break;
        default:
          this.logger.warn('[WorkflowStep] Unknown callback_id', { callbackId });
          result = {
            success: false,
            error: `Unknown workflow step: ${callbackId}`,
          };
      }
      // Report result to Slack
      if (result.success) {
        const reported = await this.slackClient.functionCompleteSuccess(function_execution_id, result.outputs);
        if (!reported) {
          // Critical: Slack API call failed - workflow will hang
          this.logger.error('[WorkflowStep] CRITICAL: Failed to report success to Slack - workflow may hang', {
            functionExecutionId: function_execution_id,
            callbackId,
          });
        }

        // Send DM notification if enabled (default: false - industry standard is silent execution)
        const sendNotification = (inputs.send_notification as boolean) ?? false;
        if (sendNotification && result.notificationMessage && result.slackUserId) {
          try {
            await this.slackClient.sendDirectMessage(result.slackUserId, result.notificationMessage);
          } catch (dmError) {
            // Don't fail the workflow if DM fails - just log it
            this.logger.error('[WorkflowStep] Failed to send DM notification user requested', {
              slackUserId: result.slackUserId,
              functionExecutionId: function_execution_id,
              error: dmError instanceof Error ? dmError.message : String(dmError),
            });
          }
        }
      } else {
        // result.success is false, so result.error is guaranteed to exist
        const reported = await this.slackClient.functionCompleteError(function_execution_id, result.error);
        if (!reported) {
          // Critical: Slack API call failed - workflow will hang
          this.logger.error('[WorkflowStep] CRITICAL: Failed to report error to Slack - workflow may hang', {
            functionExecutionId: function_execution_id,
            callbackId,
            originalError: result.error,
          });
        }
      }
    } catch (error) {
      this.logger.error('[WorkflowStep] Unhandled error in step execution', {
        callbackId,
        functionExecutionId: function_execution_id,
        error: error instanceof Error ? error.message : String(error),
        totalDurationMs: Date.now() - startTime,
      });

      const reported = await this.slackClient.functionCompleteError(
        function_execution_id,
        error instanceof Error ? error.message : 'An unexpected error occurred'
      );
      if (!reported) {
        this.logger.error('[WorkflowStep] CRITICAL: Failed to report unhandled error to Slack - workflow may hang', {
          functionExecutionId: function_execution_id,
          callbackId,
        });
      }
    }
  }

  /**
   * Find B4M user by Slack user ID
   */
  private async findB4MUser(slackUserId: string): Promise<IUserDocument | null> {
    const { User } = getSlackDb();
    return (User as any).findOne({ 'slackSettings.slackUserId': slackUserId });
  }

  /**
   * Trigger AI processing for a quest (fire-and-forget)
   * The AI will process in the background and update the quest with a response
   */
  private async triggerAIProcessing(
    user: IUserDocument,
    sessionId: string,
    questId: string,
    message: string
  ): Promise<void> {
    try {
      const { chatCompletionDefaults, eventBus } = getSlackDeps();
      // any: defaultChatCompletionOptions provides remaining IChatCompletionServiceOptions fields at runtime
      const chatCompletion = new ChatCompletionInvoke({
        ...chatCompletionDefaults.defaultChatCompletionOptions,
        queue: new SQSService(),
        tokenizer: chatCompletionDefaults.getSharedTokenizer(this.logger),
        user,
        sessionId,
        logger: this.logger,
        invokeLambda: async (params: unknown) => {
          await eventBus.LLMEvents.CompletionStart.publish(params);
        },
      } as any);

      // Trigger AI response using the existing quest
      await chatCompletion.invoke({
        body: {
          params: {
            model: ChatModels.GPT4_1_MINI,
            temperature: 0.9,
            top_p: 1,
            n: 1,
            stream: false,
            max_tokens: 4000,
            presence_penalty: 0,
            frequency_penalty: 0,
            logit_bias: {},
          },
          sessionId,
          message,
          messageFileIds: [],
          historyCount: 5,
          fabFileIds: [],
          dashboardParams: {
            dashboardDataSources: [],
          },
          questId, // Use existing quest instead of creating a new one
          enableQuestMaster: false,
          enableMementos: false,
          enableArtifacts: false,
          enableAgents: true,
          organizationId: user.organizationId,
        },
        userId: user.id,
      });
    } catch (error) {
      // Don't fail the workflow if AI trigger fails - just log it
      this.logger.error('[WorkflowStep] Failed to trigger AI processing', {
        questId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle "Create Notebook" workflow step
   * Inputs: user_id (required), notebook_name (optional)
   * Outputs: notebook_id, notebook_name, notebook_url
   */
  private async handleCreateNotebook(inputs: CreateNotebookInputs): Promise<WorkflowStepResult> {
    // Validate APP_URL is configured
    if (!process.env.APP_URL) {
      this.logger.error('[WorkflowStep] APP_URL environment variable is not set');
      return {
        success: false,
        error: 'Server configuration error: APP_URL is not set. Please contact support.',
      };
    }

    const { user_id: slackUserId, notebook_name } = inputs;

    // Validate required input (runtime check since inputs come from Slack)
    if (!slackUserId) {
      return {
        success: false,
        error: 'Required input "user_id" is missing or invalid',
      };
    }

    const notebookName = notebook_name || this.generateNotebookName();

    // Find B4M user
    const user = await this.findB4MUser(slackUserId);
    if (!user) {
      return {
        success: false,
        error:
          'Your Slack account is not linked to B4M. Go to your profile settings in the B4M web app to connect your Slack account.',
      };
    }

    try {
      // Create session using existing session manager
      const { defineAbilitiesFor } = getSlackDb();
      const { sessionManager } = getSlackDeps();
      const ability = defineAbilitiesFor(user);
      const newSession = await (sessionManager as any).createSession(user.id, { name: notebookName }, ability, {
        setLastNotebook: true,
      });

      const appUrl = process.env.APP_URL;
      const notebookUrl = `${appUrl}/notebooks/${newSession.id}`;

      this.logger.info('[WorkflowStep] Notebook created', {
        notebookId: newSession.id,
        notebookName: newSession.name,
        userId: user.id,
      });

      return {
        success: true,
        outputs: {
          notebook_id: newSession.id,
          notebook_name: newSession.name,
          notebook_url: notebookUrl,
        },
        slackUserId,
        notificationMessage: `✅ Notebook created: *${newSession.name}*\n${notebookUrl}`,
      };
    } catch (error) {
      this.logger.error('[WorkflowStep] Failed to create notebook', {
        error: error instanceof Error ? error.message : String(error),
        slackUserId,
      });

      return {
        success: false,
        error: `Failed to create notebook: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Handle "Send to B4M" workflow step
   * Inputs: user_id (required), message (required), notebook_id (optional), wait_for_response (optional)
   * Outputs: quest_id, response (if wait_for_response=true)
   */
  private async handleSendMessage(inputs: SendMessageInputs): Promise<WorkflowStepResult> {
    // Validate APP_URL is configured
    if (!process.env.APP_URL) {
      this.logger.error('[WorkflowStep] APP_URL environment variable is not set');
      return {
        success: false,
        error: 'Server configuration error: APP_URL is not set. Please contact support.',
      };
    }

    const { user_id: slackUserId, message, notebook_id: notebookId, wait_for_response } = inputs;
    const waitForResponse = wait_for_response ?? true;

    // Validate required inputs (runtime check since inputs come from Slack)
    if (!slackUserId) {
      return {
        success: false,
        error: 'Required input "user_id" is missing or invalid',
      };
    }

    if (!message || message.trim().length === 0) {
      return {
        success: false,
        error: 'Required input "message" is missing or empty',
      };
    }

    // Find B4M user
    const user = await this.findB4MUser(slackUserId);
    if (!user) {
      return {
        success: false,
        error:
          'Your Slack account is not linked to B4M. Go to your profile settings in the B4M web app to connect your Slack account.',
      };
    }

    try {
      // Determine which notebook to use
      let resolvedNotebookId: string;

      if (notebookId) {
        resolvedNotebookId = notebookId;
      } else if (user.slackSettings?.defaultNotebookId) {
        resolvedNotebookId = user.slackSettings.defaultNotebookId;
      } else if (user.lastNotebookId) {
        resolvedNotebookId = user.lastNotebookId.toString();
      } else {
        // No existing notebook, create one
        const { defineAbilitiesFor: defineAbilities } = getSlackDb();
        const { sessionManager: sm } = getSlackDeps();
        const abilityForCreate = defineAbilities(user);
        const newSession = await (sm as any).createSession(
          user.id,
          { name: this.generateNotebookName() },
          abilityForCreate,
          {
            setLastNotebook: true,
          }
        );
        resolvedNotebookId = newSession.id;
      }

      // Add message to session
      const { defineAbilitiesFor: defineAbilitiesForMsg } = getSlackDb();
      const { sessionManager: smForMsg } = getSlackDeps();
      const ability = defineAbilitiesForMsg(user);
      const chatMessage: Omit<IChatHistoryItem, 'sessionId'> = {
        timestamp: new Date(),
        type: 'message',
        prompt: message,
      };

      const quest = await smForMsg.addMessageToSession(user.id, resolvedNotebookId, chatMessage, ability);

      // Trigger AI processing (fire-and-forget - don't await to save ~500ms for Slack timeout)
      this.triggerAIProcessing(user, resolvedNotebookId, quest.id!, message).catch(error => {
        // Log with correlation data for debugging async failures
        this.logger.error('[WorkflowStep] AI processing failed after workflow completion', {
          questId: quest.id,
          notebookId: resolvedNotebookId,
          userId: user.id,
          slackUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      const appUrl = process.env.APP_URL;
      const notebookUrl = `${appUrl}/notebooks/${resolvedNotebookId}`;

      // If waiting for response, poll for AI completion
      if (waitForResponse) {
        const aiResponse = await this.waitForQuestCompletion(quest.id!);

        return {
          success: true,
          outputs: {
            quest_id: quest.id,
            response: aiResponse || 'Message sent. AI processing in background.',
            notebook_id: resolvedNotebookId,
          },
          slackUserId,
          notificationMessage: `✅ Message sent to B4M\n${aiResponse ? `Response: ${aiResponse.substring(0, 200)}${aiResponse.length > 200 ? '...' : ''}` : 'AI processing in background.'}\n${notebookUrl}`,
        };
      }

      // Not waiting - just return the quest ID
      return {
        success: true,
        outputs: {
          quest_id: quest.id,
          response: 'Message sent to notebook.',
          notebook_id: resolvedNotebookId,
        },
        slackUserId,
        notificationMessage: `✅ Message sent to B4M\n${notebookUrl}`,
      };
    } catch (error) {
      this.logger.error('[WorkflowStep] Failed to send message', {
        error: error instanceof Error ? error.message : String(error),
        slackUserId,
      });

      return {
        success: false,
        error: `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Handle "Query B4M" workflow step
   * Inputs: user_id (required), query (required), notebook_id (optional)
   * Outputs: answer, sources, notebook_id
   *
   * Due to Slack's ~15 second function timeout, we don't wait for the AI response.
   * The query is submitted; the user checks their B4M notebook for the full response.
   */
  private async handleQuery(inputs: QueryInputs): Promise<WorkflowStepResult> {
    // Validate APP_URL is configured
    if (!process.env.APP_URL) {
      this.logger.error('[WorkflowStep] APP_URL environment variable is not set');
      return {
        success: false,
        error: 'Server configuration error: APP_URL is not set. Please contact support.',
      };
    }

    const { user_id: slackUserId, query, notebook_id: notebookId } = inputs;

    // Validate required inputs (runtime check since inputs come from Slack)
    if (!slackUserId) {
      return {
        success: false,
        error: 'Required input "user_id" is missing or invalid',
      };
    }

    if (!query || query.trim().length === 0) {
      return {
        success: false,
        error: 'Required input "query" is missing or empty',
      };
    }

    // Find B4M user
    const user = await this.findB4MUser(slackUserId);
    if (!user) {
      return {
        success: false,
        error:
          'Your Slack account is not linked to B4M. Go to your profile settings in the B4M web app to connect your Slack account.',
      };
    }

    try {
      // Determine which notebook to use
      let resolvedNotebookId: string;

      if (notebookId) {
        resolvedNotebookId = notebookId;
      } else if (user.slackSettings?.defaultNotebookId) {
        resolvedNotebookId = user.slackSettings.defaultNotebookId;
      } else if (user.lastNotebookId) {
        resolvedNotebookId = user.lastNotebookId.toString();
      } else {
        // No existing notebook, create one for this query
        const { defineAbilitiesFor: defineAbilitiesQ } = getSlackDb();
        const { sessionManager: smQ } = getSlackDeps();
        const abilityQ = defineAbilitiesQ(user);
        const newSession = await (smQ as any).createSession(
          user.id,
          { name: `Query - ${new Date().toLocaleDateString()}` },
          abilityQ,
          { setLastNotebook: true }
        );
        resolvedNotebookId = newSession.id;
      }

      // Add query to session - don't wait for AI response due to Slack timeout constraints
      const { defineAbilitiesFor: defineAbilitiesQuery } = getSlackDb();
      const { sessionManager: smQuery } = getSlackDeps();
      const ability = defineAbilitiesQuery(user);
      const chatMessage: Omit<IChatHistoryItem, 'sessionId'> = {
        timestamp: new Date(),
        type: 'message',
        prompt: query,
      };

      const quest = await smQuery.addMessageToSession(user.id, resolvedNotebookId, chatMessage, ability);

      // Trigger AI processing (fire-and-forget - don't await to save ~500ms for Slack timeout)
      this.triggerAIProcessing(user, resolvedNotebookId, quest.id!, query).catch(error => {
        // Log with correlation data for debugging async failures
        this.logger.error('[WorkflowStep] AI processing failed after workflow completion', {
          questId: quest.id,
          notebookId: resolvedNotebookId,
          userId: user.id,
          slackUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      // Get notebook info for the response
      const { Session } = getSlackDb();
      const session = await (Session as any).findById(resolvedNotebookId);
      const appUrl = process.env.APP_URL;
      const notebookUrl = `${appUrl}/notebooks/${resolvedNotebookId}`;

      return {
        success: true,
        outputs: {
          answer: `Query submitted to B4M. Check your notebook for the AI response: ${notebookUrl}`,
          sources: session ? `Notebook: ${session.name}` : '',
          notebook_id: resolvedNotebookId,
        },
        slackUserId,
        notificationMessage: `✅ Query submitted to B4M\nCheck your notebook for the AI response:\n${notebookUrl}`,
      };
    } catch (error) {
      this.logger.error('[WorkflowStep] Failed to process query', {
        error: error instanceof Error ? error.message : String(error),
        slackUserId,
      });

      return {
        success: false,
        error: `Failed to process query: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Wait for a quest to complete and return the AI response
   * Polls the quest status with timeout
   */
  private async waitForQuestCompletion(questId: string): Promise<string | null> {
    const maxWaitTime = 10000; // 10 seconds (Slack function timeout is ~15s, need buffer for overhead + Slack API call)
    const pollInterval = 1000; // 1 second
    let elapsedTime = 0;

    this.logger.debug('[WorkflowStep] Waiting for quest completion', { questId });
    const { Quest } = getSlackDb();

    while (elapsedTime < maxWaitTime) {
      try {
        const quest = await (Quest as any).findById(questId);

        if (quest?.status === 'done') {
          // Return the first reply if available
          const response = quest.replies?.[0] || quest.reply || null;
          this.logger.debug('[WorkflowStep] Quest completed', {
            questId,
            hasResponse: !!response,
          });
          return response;
        }

        if (quest?.status === 'stopped') {
          this.logger.warn('[WorkflowStep] Quest stopped', { questId });
          return null;
        }
      } catch (error) {
        this.logger.error('[WorkflowStep] Error polling quest status', {
          questId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Return null on database errors rather than crashing the workflow
        return null;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      elapsedTime += pollInterval;
    }

    this.logger.warn('[WorkflowStep] Quest completion timed out', { questId, elapsedTime });
    return null;
  }

  /**
   * Generate a default notebook name
   */
  private generateNotebookName(): string {
    return `Workflow - ${new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
}
