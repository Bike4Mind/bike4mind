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

export const LOCAL_SESSION_CONTINUES = 'Still signed out; chatting with local models. Run /login to try again.';

/** Slash commands that only talk to Bike4Mind, with what each one is for. */
const CLOUD_ONLY_COMMANDS = new Map([['usage', 'shows Bike4Mind credits']]);

/** The answer to a cloud-only slash command in a signed-out local session; null for any other command. */
export function signedOutCommandMessage(command: string): string | null {
  const purpose = CLOUD_ONLY_COMMANDS.get(command);
  return purpose ? `/${command} ${purpose}, so it needs you to be signed in. ${SIGN_IN_HINT}` : null;
}

/** For headless and ACP runs, where /login cannot be typed. */
export const SIGN_IN_OUTSIDE_HINT = 'To use Bike4Mind cloud models instead, sign in: run b4m, then /login.';

export const SIGN_IN_EXPIRED =
  'Your Bike4Mind sign-in expired; chatting with local models. Run /login to sign in again.';

export const SIGN_IN_EXPIRED_HEADLESS = `Bike4Mind sign-in expired; running on local models. ${SIGN_IN_OUTSIDE_HINT}`;

/** The saved sign-in could not be refreshed (network, timeout, server error) and is kept for the next run. */
export function signInUncheckedMessage(reason: string): string {
  return `Could not check your Bike4Mind sign-in (${clean(reason)}); chatting with local models for now. Restart b4m to try again.`;
}

/** As `signInUncheckedMessage`, when nothing local can chat and the sign-in flow starts instead. */
export function signInUncheckedLoginMessage(reason: string): string {
  return `Could not check your Bike4Mind sign-in (${clean(reason)}). Sign in to continue, or restart b4m to try again.`;
}

export function signInUncheckedHeadlessMessage(reason: string): string {
  return `Could not check the Bike4Mind sign-in (${clean(reason)}); running on local models for this run.`;
}

/**
 * Headless (`-p`) runs signed out never swap a cloud default for a local model on their own, unless a local
 * default was saved; this is the error when none was.
 */
export function signedOutHeadlessCloudModelMessage(model: string): string {
  return `Not signed in, and the default model ${clean(model)} is not a local model. Pick a local model with: b4m models use <name>. ${SIGN_IN_OUTSIDE_HINT}`;
}

export function savedServerDownMessage(model: string, server: string, error: string): string {
  return `The saved local default ${clean(model)} is on the model server ${clean(server)}, which could not be reached or listed: ${clean(error).replace(/\.+$/, '')}. Fix that and try again, or pick another model with: b4m models use <name>.`;
}

/** Signed out and nothing local can chat. `reason` says what was found and how to fix it. */
export class NoLocalModelsError extends Error {
  constructor(readonly reason: string) {
    super(`${reason}\n${SIGN_IN_OUTSIDE_HINT}`);
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
