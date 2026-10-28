import type { LocalContextFit } from '@shared/localContextSetting';
import { parseLocalModelId, type ChatModelOption } from '@shared/chat';
import type { CompletionRequest } from '../chat/completions';
import type { LocalChat } from '../chat/localChat';
import type { OllamaLocal } from '../chat/OllamaLocal';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import type { ModelServerRegistry } from './ModelServerRegistry';

/**
 * Every device-side model: this computer's Ollama, then each saved server's. A `local:srv-<id>:...`
 * model goes to that server's client; every other local id to this computer, as before.
 */
export class LocalModels implements LocalChat {
  constructor(
    private readonly computer: OllamaLocal,
    private readonly servers: Pick<ModelServerRegistry, 'models' | 'chatFor'>
  ) {}

  async models(): Promise<ChatModelOption[]> {
    const [own, remote] = await Promise.all([this.computer.models(), this.servers.models().catch(() => [])]);
    return [...own, ...remote];
  }

  contextFit(): Promise<LocalContextFit> {
    return this.computer.contextFit();
  }

  stream(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal?: AbortSignal,
    onTrimmed?: (dropped: number) => void,
    onNotice?: (message: string) => void
  ): Promise<void> {
    return this.route(request.model).stream(request, onEvent, signal, onTrimmed, onNotice);
  }

  contextTokens(modelId: string, signal?: AbortSignal): Promise<number> {
    return this.route(modelId).contextTokens(modelId, signal);
  }

  growFor(modelId: string, tokens: number): Promise<number | undefined> {
    return this.route(modelId).growFor(modelId, tokens);
  }

  private route(modelId: string): LocalChat {
    const runtimeId = parseLocalModelId(modelId)?.runtimeId;
    return (runtimeId ? this.servers.chatFor(runtimeId) : null) ?? this.computer;
  }
}
