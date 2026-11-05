import type { ModelLoadOffer } from '@shared/modelSettings';
import type { CompletionRequest } from './completions';
import type { CompletionStreamEvent } from './streamEvents';

/** What ChatService needs from a device-side model runtime; OllamaLocal, OpenAICompatibleChat and LocalModels implement it. */
export interface LocalChat {
  stream(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal?: AbortSignal,
    onTrimmed?: (dropped: number) => void,
    onNotice?: (message: string) => void
  ): Promise<void>;
  /** The context the model's requests are sent with. */
  contextTokens(modelId: string, signal?: AbortSignal): Promise<number>;
  /** A larger context so `tokens` fit, or undefined when it cannot grow. */
  growFor(modelId: string, tokens: number): Promise<number | undefined>;
  /** The load-time options the model takes, for its Models screen dialog; see ModelLoadOffer. */
  loadOffer?(modelId: string, draftTokens?: number): Promise<ModelLoadOffer>;
}
