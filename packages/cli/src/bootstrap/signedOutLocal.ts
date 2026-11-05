import type { IMessage, ModelInfo } from '@bike4mind/common';
import type { CompletionInfo, ICompletionBackend, ICompletionOptions } from '@bike4mind/llm-adapters';
import { clean } from '../models/localModels.js';

export const SIGN_IN_HINT = 'Run /login to sign in and use Bike4Mind cloud models.';

export const SIGNED_OUT_BANNER =
  'Signed out: chatting with local models only. Run /login to use Bike4Mind cloud models.';

export function signedOutCloudModelMessage(model: string): string {
  return `${clean(model)} is a Bike4Mind cloud model and needs you to be signed in. ${SIGN_IN_HINT}`;
}

export function signedOutNoMatchMessage(query: string): string {
  return `No local model matches "${clean(query)}". Cloud models are not listed while you are signed out. ${SIGN_IN_HINT}`;
}

/** Signed out, the default model is not listed locally, so a local one stands in for this session. */
export function signedOutDefaultReplacedMessage(defaultModel: string, localModel: string): string {
  return `Default model ${clean(defaultModel)} is not a local model; using ${clean(localModel)}. If it is a Bike4Mind cloud model, sign in with /login to use it.`;
}

/** Signed out and nothing local can chat. `reason` says what was found and how to fix it. */
export class NoLocalModelsError extends Error {
  constructor(readonly reason: string) {
    super(`${reason}\n${SIGN_IN_HINT}`);
    this.name = 'NoLocalModelsError';
  }
}

export const INSTALL_OLLAMA_HINT =
  'Start Ollama (open the Ollama app or run "ollama serve"), or install it from https://ollama.com/download, then pull a model: ollama pull qwen3.5';

/**
 * Stands in for the Bike4Mind server backend while signed out: it lists no models and answers
 * every completion with how to sign in, so a cloud model reached by id never touches the network.
 */
export class SignedOutCloudBackend implements ICompletionBackend {
  constructor(public currentModel: string) {}

  async complete(
    model: string,
    _messages: IMessage[],
    _options: Partial<ICompletionOptions>,
    _callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    throw new Error(signedOutCloudModelMessage(model));
  }

  pushToolMessages(): void {}

  async getModelInfo(): Promise<ModelInfo[]> {
    return [];
  }
}
