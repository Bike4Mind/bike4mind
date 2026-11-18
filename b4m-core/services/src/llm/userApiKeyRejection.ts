import { ModelBackend, type AdapterFamily } from '@bike4mind/common';
import { getHttpStatus } from '@bike4mind/utils';
import { userKeyProviders, type UserKeyProvider } from '../apiKeyService';

type ChatKeyProvider = Extract<
  UserKeyProvider,
  'openai' | 'anthropic' | 'gemini' | 'xai' | 'kimi' | 'deepseek' | 'bfl'
>;

const PROVIDER_DISPLAY_NAME: Readonly<Record<ChatKeyProvider, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  xai: 'xAI',
  kimi: 'Moonshot',
  deepseek: 'DeepSeek',
  bfl: 'BFL',
};

const ADAPTER_FAMILY_KEY: Readonly<Partial<Record<AdapterFamily, ChatKeyProvider>>> = {
  'openai-chat': 'openai',
  'openai-responses': 'openai',
  'anthropic-messages': 'anthropic',
  gemini: 'gemini',
  xai: 'xai',
  kimi: 'kimi',
  deepseek: 'deepseek',
  bfl: 'bfl',
};

const BACKEND_KEY: Readonly<Partial<Record<ModelBackend, ChatKeyProvider>>> = {
  [ModelBackend.OpenAI]: 'openai',
  [ModelBackend.Anthropic]: 'anthropic',
  [ModelBackend.Gemini]: 'gemini',
  [ModelBackend.XAI]: 'xai',
  [ModelBackend.Kimi]: 'kimi',
  [ModelBackend.DeepSeek]: 'deepseek',
  [ModelBackend.BFL]: 'bfl',
};

/**
 * Which key-table entry authenticates a model's calls, or undefined for a keyless route (Bedrock,
 * Ollama, ...). MUST STAY IN SYNC WITH getLlmByModel (llm-adapters/src/index.ts) and
 * backendForAdapterFamily (llm-adapters/src/adapterFamilyDispatch.ts): family first, then backend.
 */
export function apiKeyProviderOf(model: {
  backend: ModelBackend;
  adapterFamily?: AdapterFamily;
}): ChatKeyProvider | undefined {
  return model.adapterFamily ? ADAPTER_FAMILY_KEY[model.adapterFamily] : BACKEND_KEY[model.backend];
}

export const userApiKeyRejectedReply = (provider: ChatKeyProvider): string =>
  `Your ${PROVIDER_DISPLAY_NAME[provider]} API key was rejected by the provider. ` +
  'Update or remove it in your API key settings.';

/**
 * A provider refused the user's own saved key (401/403). An expected user-side outcome, not an
 * outage: our platform key was never involved. Keeps the provider's message and `status` so the
 * fallback classifiers (shouldTriggerFallback, getHttpStatus) treat it exactly like the original.
 */
export class UserApiKeyRejectedError extends Error {
  readonly status: number;

  constructor(
    readonly provider: ChatKeyProvider,
    readonly modelId: string,
    status: number,
    options: { cause: Error }
  ) {
    super(options.cause.message, options);
    this.name = 'UserApiKeyRejectedError';
    this.status = status;
  }

  /** Structured log fields. Never the key, the provider message (it can echo a masked key) or a request id. */
  get logFields() {
    return { provider: this.provider, model: this.modelId, status: this.status, keySource: 'user' as const };
  }
}

/**
 * Wrap `error` as a UserApiKeyRejectedError when it is a 401/403 from a provider whose key in
 * `apiKeyTable` (the object getEffectiveLLMApiKeys returned, not a copy) came from the user. A
 * platform-key 401 is left as is: that one is an outage.
 */
export function asUserApiKeyRejection(
  error: Error,
  model: { id: string; backend: ModelBackend; adapterFamily?: AdapterFamily },
  apiKeyTable: object
): UserApiKeyRejectedError | undefined {
  if (error instanceof UserApiKeyRejectedError) return error;
  const status = getHttpStatus(error);
  if (status !== 401 && status !== 403) return undefined;
  const provider = apiKeyProviderOf(model);
  if (!provider || !userKeyProviders(apiKeyTable).has(provider)) return undefined;
  return new UserApiKeyRejectedError(provider, String(model.id), status, { cause: error });
}
