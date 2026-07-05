import { Logger } from '@bike4mind/observability';
import { ImageModels, ChatModels } from '@bike4mind/common';
import { getSlackDeps, getSlackDb } from './di';
import { getImageConfigForModel } from './constants/slack-image-defaults';

export interface TriggerImageGenerationParams {
  notebookId: string;
  userId: string;
  prompt: string;
  model: ImageModels;
  questId: string;
  slackNotification: {
    workspaceId: string;
    channelId: string;
    threadTs?: string;
    messageTs?: string;
    isPaintCommand?: boolean;
  };
}

/**
 * Trigger image generation via ChatCompletionInvoke pipeline.
 * Shared between /paint command handler and interactive model picker.
 * Stores slackNotification on the resulting Quest so Quest Processor can deliver the image.
 */
export async function triggerImageGeneration(params: TriggerImageGenerationParams): Promise<void> {
  const { notebookId, userId, prompt, model, slackNotification, questId } = params;
  const imageConfig = getImageConfigForModel(model);

  const { chatCompletionDefaults, eventBus } = getSlackDeps();
  const { User: SlackUser, Quest } = getSlackDb();
  const { SQSService } = await import('@bike4mind/utils');
  const { ChatCompletionInvoke } = await import('@bike4mind/services');

  // getSlackDb() DI models don't preserve Mongoose static method types
  const user = await (SlackUser as Record<string, (...args: unknown[]) => unknown>).findById(userId);
  if (!user) {
    Logger.error('🎨 [IMAGE-GEN] User not found', { userId });
    return;
  }

  const logger = new Logger({ metadata: { component: 'ImageGeneration' } });

  // unknown: defaultChatCompletionOptions provides remaining IChatCompletionServiceOptions fields at runtime
  const chatCompletion = new ChatCompletionInvoke({
    ...chatCompletionDefaults.defaultChatCompletionOptions,
    queue: new SQSService(),
    tokenizer: chatCompletionDefaults.getSharedTokenizer(logger),
    user,
    sessionId: notebookId,
    logger,
    invokeLambda: async (invokeParams: unknown) => {
      await eventBus.LLMEvents.CompletionStart.publish(invokeParams);
    },
  } as unknown as ConstructorParameters<typeof ChatCompletionInvoke>[0]);

  const quest = await chatCompletion.invoke({
    body: {
      params: {
        model: ChatModels.GPT4_1_MINI,
        temperature: 0,
        top_p: 1,
        n: 1,
        stream: false,
        max_tokens: 4096,
        presence_penalty: 0,
        frequency_penalty: 0,
        logit_bias: {},
      },
      sessionId: notebookId,
      message: prompt,
      messageFileIds: [],
      historyCount: 0,
      fabFileIds: [],
      dashboardParams: { dashboardDataSources: [] },
      questId,
      imageConfig,
      tools: ['image_generation'],
      extraContextMessages: [
        {
          role: 'system' as const,
          content:
            'Call image_generation with the user prompt EXACTLY as-is in a SINGLE tool call. Do NOT rewrite, simplify, or split the prompt into multiple calls.',
        },
      ],
      enableQuestMaster: false,
      enableMementos: false,
      enableArtifacts: false,
      enableAgents: false,
      organizationId: (user as Record<string, unknown>).organizationId?.toString(),
    },
    userId,
  });

  if (quest) {
    await (Quest as Record<string, (...args: unknown[]) => unknown>).findByIdAndUpdate(quest.id, {
      slackNotification: { ...slackNotification, isPaintCommand: true },
    });
    Logger.info('🎨 [IMAGE-GEN] Generation triggered', { questId: quest.id, model });
  }
}
