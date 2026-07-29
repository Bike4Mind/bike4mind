import { ModelInfo } from '@bike4mind/common';
import { ICompletionBackend } from '@bike4mind/llm-adapters';
import { ModelBackend, ApiKeyType } from '@bike4mind/common';

export interface OperationsModelConfig {
  modelId: string;
  imageModelId: string;
  speechModelId: string;
}

export interface OperationsModelResult {
  llm: ICompletionBackend;
  modelId: string;
  modelInfo: ModelInfo;
  imageLlm: ICompletionBackend;
  imageModelId: string;
  imageModelInfo: ModelInfo;
  speechLlm: ICompletionBackend | null;
  speechModelId: string | null;
  speechModelInfo: ModelInfo | null;
}

export const getApiKeyTypeFromBackend = (backend: ModelBackend): ApiKeyType | null => {
  switch (backend) {
    case ModelBackend.OpenAI:
      return ApiKeyType.openai;
    case ModelBackend.Anthropic:
      return ApiKeyType.anthropic;
    case ModelBackend.Gemini:
      return ApiKeyType.gemini;
    case ModelBackend.BFL:
      return ApiKeyType.bfl;
    case ModelBackend.Ollama:
      return ApiKeyType.ollama;
    case ModelBackend.XAI:
      return ApiKeyType.xai;
    case ModelBackend.Kimi:
      return ApiKeyType.kimi;
    case ModelBackend.VoyageAI:
      return ApiKeyType.voyageai;
    // AWS-credentialed backends hold no API key of their own, and local-image is
    // a base URL. Enumerated rather than left to `default` so that adding a
    // ModelBackend is a compile error here: this function's null return is the
    // "no key configured" diagnostic, so a provider that falls through silently
    // loses its error message as well as its key.
    case ModelBackend.Bedrock:
    case ModelBackend.AWS:
    case ModelBackend.LocalImage:
      return null;
  }
};

/**
 * Get default image model with fallback priority
 */
export function getDefaultImageModel(models: ModelInfo[]): ModelInfo | undefined {
  // Priority order: FLUX_PRO_1_1 -> FLUX_KONTEXT_PRO -> GPT_IMAGE_2 -> any image model
  return (
    models.find(m => m.id === 'flux-pro-1.1') ||
    models.find(m => m.id === 'flux-kontext-pro') ||
    models.find(m => m.id === 'gpt-image-2') ||
    models.find(m => m.type === 'image')
  );
}
