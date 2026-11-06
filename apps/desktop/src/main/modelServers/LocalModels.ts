import type { LocalContextFit } from '@shared/localContextSetting';
import { parseLocalModelId, type ChatModelOption, type ContextNoticeKind } from '@shared/chat';
import type { CatalogSampling } from '@shared/generation';
import type { ModelLoadOffer } from '@shared/modelSettings';
import type { CompletionRequest } from '../chat/completions';
import type { LocalChat } from '../chat/localChat';
import type { OllamaLocal } from '../chat/OllamaLocal';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import type { ModelListOptions, ModelServerRegistry } from './ModelServerRegistry';

export interface CatalogSamplingQuery {
  name: string;
  modelBlob?: string | undefined;
  parameters?: string | undefined;
  hasAdapter?: boolean | undefined;
}

export type CatalogSamplingHook = (model: CatalogSamplingQuery) => CatalogSampling | undefined;

/** Adapts a hook to a model option's name, weights blob and Modelfile parameters. */
export function optionCatalogSampling(hook: CatalogSamplingHook | undefined) {
  return (option: ChatModelOption) =>
    hook?.({
      name: option.name,
      modelBlob: option.modelBlob,
      parameters: option.modelParameters,
      hasAdapter: option.hasAdapter,
    });
}

/**
 * Every device-side model: this computer's Ollama, then each saved server's. A `local:srv-<id>:...`
 * model goes to that server's client; every other local id to this computer, as before.
 */
export class LocalModels implements LocalChat {
  constructor(
    private readonly computer: OllamaLocal,
    private readonly servers: Pick<ModelServerRegistry, 'models' | 'chatFor'>,
    /** The curated catalog's sampling for a listed model; see main/models/catalogSampling.ts. */
    private readonly catalogSampling?: (option: ChatModelOption) => CatalogSampling | undefined
  ) {}

  async models(options?: ModelListOptions): Promise<ChatModelOption[]> {
    const [own, remote] = await Promise.all([this.computer.models(), this.servers.models(options).catch(() => [])]);
    return [...own, ...remote].map(option => {
      const sampling = this.catalogSampling?.(option);
      return sampling ? { ...option, catalogSampling: sampling } : option;
    });
  }

  contextFit(): Promise<LocalContextFit> {
    return this.computer.contextFit();
  }

  stream(
    request: CompletionRequest,
    onEvent: (event: CompletionStreamEvent) => void,
    signal?: AbortSignal,
    onTrimmed?: (dropped: number) => void,
    onNotice?: (message: string, kind?: ContextNoticeKind) => void
  ): Promise<void> {
    return this.route(request.model).stream(request, onEvent, signal, onTrimmed, onNotice);
  }

  contextTokens(modelId: string, signal?: AbortSignal): Promise<number> {
    return this.route(modelId).contextTokens(modelId, signal);
  }

  growFor(modelId: string, tokens: number): Promise<number | undefined> {
    return this.route(modelId).growFor(modelId, tokens);
  }

  async loadOffer(modelId: string, draftTokens?: number): Promise<ModelLoadOffer> {
    return (await this.route(modelId).loadOffer?.(modelId, draftTokens)) ?? {};
  }

  private route(modelId: string): LocalChat {
    const runtimeId = parseLocalModelId(modelId)?.runtimeId;
    return (runtimeId ? this.servers.chatFor(runtimeId) : null) ?? this.computer;
  }
}
