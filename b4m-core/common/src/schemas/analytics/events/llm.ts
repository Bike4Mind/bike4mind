import { IBaseEvent, CompletionSource } from '../../../types';

export enum LLMEvents {
  QUEUE_HANDLER_START_HEARD_PROMPT = 'Prompt Heard',
  QUEUE_HANDLER_START_MODEL = 'Model Started',
  QUEUE_HANDLER_START_AUTO_NAMED_SESSION = 'Auto-Named Session Started',
  QUEUE_HANDLER_IMAGE_GENERATE = 'Image Generation Completed',
  QUEUE_HANDLER_VIDEO_GENERATE = 'Video Generation Completed',
  MEMENTO_CREATION_ERROR = 'Memento Creation Failed',
  QUEST_MASTER_ERROR = 'QuestMaster Processing Failed',
  AUTO_NAMING_ERROR = 'Auto Naming Failed',
}

interface IQueueHandlerStartHeardPromptEvent extends IBaseEvent {
  type: LLMEvents.QUEUE_HANDLER_START_HEARD_PROMPT;
  metadata: {
    /** ID of the session */
    sessionId: string;
    /** ID of the quest */
    questId: string;
    /** The prompt that was heard */
    promptMessage: string;
  };
}

interface IQueueHandlerStartModelEvent extends IBaseEvent {
  type: LLMEvents.QUEUE_HANDLER_START_MODEL;
  metadata: {
    /** ID of the session */
    sessionId: string;
    /** ID of the quest */
    questId: string;
    /** Model name */
    modelName: string;
    /**
     * Where this completion originated (web chat, agent executor, etc.). Used
     * to break down `Top Models` by surface in the daily/weekly report.
     * Optional for backward compatibility with legacy event consumers.
     */
    source?: CompletionSource;
  };
}

interface IQueueHandlerStartAutoNamedSessionEvent extends IBaseEvent {
  type: LLMEvents.QUEUE_HANDLER_START_AUTO_NAMED_SESSION;
  metadata: {
    /** ID of the session */
    sessionId: string;
    /** ID of the quest */
    questId: string;
    /** The threshold for auto naming sessions */
    autoNameSessionTriggerThreshold: number;
    /** The number of conversations in the session when it was auto named */
    conversationCount: number;
  };
}

interface IQueueHandlerImageGenerateEvent extends IBaseEvent {
  type: LLMEvents.QUEUE_HANDLER_IMAGE_GENERATE;
  metadata: {
    /** ID of the session */
    sessionId: string;
    /** ID of the quest */
    questId: string;
    /** The prompt that was used to generate the image */
    promptMessage: string;
    /** The total number of images generated */
    totalImagesGenerated: number;
    /** The AI vendor used to generate the image. Eg., openai, midjourney */
    vendor: string;
    /** The model used to generate the image, if applicable */
    model?: string;
  };
}

interface IQueueHandlerVideoGenerateEvent extends IBaseEvent {
  type: LLMEvents.QUEUE_HANDLER_VIDEO_GENERATE;
  metadata: {
    /** ID of the quest */
    questId: string;
    /** The model used to generate the video */
    modelId: string;
  };
}

interface IMementoCreationErrorEvent extends IBaseEvent {
  type: LLMEvents.MEMENTO_CREATION_ERROR;
  metadata: {
    /** ID of the session */
    sessionId: string;
    /** ID of the quest */
    questId: string;
    /** Error message */
    error: string;
  };
}

interface IQuestMasterErrorEvent extends IBaseEvent {
  type: LLMEvents.QUEST_MASTER_ERROR;
  metadata: {
    /** ID of the session */
    sessionId: string;
    /** ID of the quest */
    questId: string;
    /** Error message */
    error: string;
  };
}

interface IAutoNamingErrorEvent extends IBaseEvent {
  type: LLMEvents.AUTO_NAMING_ERROR;
  metadata: {
    /** ID of the session */
    sessionId: string;
    /** ID of the quest */
    questId: string;
    /** Error message */
    error: string;
    /** The threshold for auto naming sessions */
    autoNameSessionTriggerThreshold: number;
    /** The number of conversations in the session */
    conversationCount: number;
  };
}

export type LLMEventPayload =
  | IQueueHandlerStartHeardPromptEvent
  | IQueueHandlerStartModelEvent
  | IQueueHandlerStartAutoNamedSessionEvent
  | IQueueHandlerImageGenerateEvent
  | IQueueHandlerVideoGenerateEvent
  | IMementoCreationErrorEvent
  | IQuestMasterErrorEvent
  | IAutoNamingErrorEvent;
