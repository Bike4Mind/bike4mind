import { ImageModelName } from '../../../models';
import { IBaseEvent, CompletionSource } from '../../../types';

export enum AiEvents {
  AI_GENERATE_IMAGE = 'AI Image Generated',
  NOTEBOOK_SUMMARIZATION = 'Notebook Summarization Completed',
  AI_VOICE_SESSION_STARTED = 'AI Voice Session Started',
  WHATS_NEW_MODAL_GENERATED = "What's New Modal Generated",
  COMPLETION_API_COMPLETED = 'Completion API Completed',
  COMPLETION_API_FAILED = 'Completion API Failed',
}

interface IGenerateImageEvent extends IBaseEvent {
  type: AiEvents.AI_GENERATE_IMAGE;
  metadata: {
    /** ID of the quest used */
    questId: string;
    /** ID of the model used for generation */
    modelId?: ImageModelName;
  };
}

interface INotebookSummarizationEvent extends IBaseEvent {
  type: AiEvents.NOTEBOOK_SUMMARIZATION;
  metadata: {
    /** ID of the session used for summarization */
    sessionId: string;
  };
}

interface IVoiceSessionStartedEvent extends IBaseEvent {
  type: AiEvents.AI_VOICE_SESSION_STARTED;
  metadata: {
    /** ID of the session used for voice session */
    sessionId: string;
    /** ID of the model used for voice session */
    model: string;
  };
}

interface IWhatsNewModalGeneratedEvent extends IBaseEvent {
  type: AiEvents.WHATS_NEW_MODAL_GENERATED;
  metadata: {
    /** ID of the generated modal */
    modalId: string;
    /** Release tag/version */
    releaseTag: string;
    /** Correlation ID for tracing */
    correlationId: string;
    /** Model ID used for generation */
    modelId: string;
  };
}

interface ICompletionApiCompletedEvent extends IBaseEvent {
  type: AiEvents.COMPLETION_API_COMPLETED;
  metadata: {
    /**
     * Model used for completion. Named `modelName` (not `model`) so this event
     * is grouped together with web chat's `"Model Started"` event by the
     * report's `topModels` aggregation, which keys on `metadata.modelName`.
     */
    modelName: string;
    /** Input tokens consumed */
    inputTokens: number;
    /** Output tokens generated */
    outputTokens: number;
    /** Total duration in milliseconds */
    durationMs: number;
    /** Whether streaming was used */
    stream: boolean;
    /** API key ID if authenticated via API key */
    apiKeyId?: string;
    /** Authentication method */
    authMethod: 'api_key' | 'jwt';
    /** Credits consumed */
    creditsUsed: number;
    /** Whether tool calls were used */
    hasToolCalls?: boolean;
    /** Correlation ID echoed as the X-Request-ID header */
    requestId?: string;
    /** Where this completion originated (cli, api, etc.) - drives report source breakdown */
    source: CompletionSource;
  };
}

interface ICompletionApiFailedEvent extends IBaseEvent {
  type: AiEvents.COMPLETION_API_FAILED;
  metadata: {
    /** Model attempted (named `modelName` to match `topModels` aggregation key) */
    modelName: string;
    /** Error message */
    error: string;
    /** Error type/code if available */
    errorType?: string;
    /** API key ID if authenticated via API key */
    apiKeyId?: string;
    /** Authentication method */
    authMethod: 'api_key' | 'jwt';
    /** Duration before failure in milliseconds */
    durationMs: number;
    /** Correlation ID echoed as the X-Request-ID header */
    requestId?: string;
    /** Where this completion originated (cli, api, etc.) */
    source: CompletionSource;
  };
}

export type AiEventPayload =
  | IGenerateImageEvent
  | INotebookSummarizationEvent
  | IVoiceSessionStartedEvent
  | IWhatsNewModalGeneratedEvent
  | ICompletionApiCompletedEvent
  | ICompletionApiFailedEvent;
