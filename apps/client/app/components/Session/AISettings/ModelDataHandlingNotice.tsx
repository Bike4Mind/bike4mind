import React from 'react';
import { Link } from '@mui/joy';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { ExternalLinks } from '@client/app/utils/externalLinks';

// Keyed by the route that actually serves the model, not by its maker: Bedrock-served Claude is
// processed by AWS Bedrock, not Anthropic. null marks backends that run on an operator's own
// open-weight server, where no third-party model provider is involved.
const SERVING_PROVIDER: Record<ModelBackend, string | null> = {
  [ModelBackend.OpenAI]: 'OpenAI',
  [ModelBackend.Anthropic]: 'Anthropic',
  [ModelBackend.Bedrock]: 'AWS Bedrock',
  [ModelBackend.AWS]: 'AWS',
  [ModelBackend.Gemini]: 'Google',
  [ModelBackend.XAI]: 'xAI',
  [ModelBackend.BFL]: 'Black Forest Labs',
  [ModelBackend.Kimi]: 'Moonshot AI',
  [ModelBackend.DeepSeek]: 'DeepSeek',
  [ModelBackend.VoyageAI]: 'Voyage AI',
  [ModelBackend.Ollama]: null,
  [ModelBackend.LocalImage]: null,
};

// Backends that get the plain "do not use your content for training" clause. OpenAI and Anthropic
// API terms exclude training by default for every key, including a user's own. Bedrock and AWS
// (Amazon Transcribe) run only on the platform's AWS account, which is opted out of AI-service
// content use; there is no user-supplied AWS credential path. Gemini is handled separately below.
const TRAINING_EXCLUSION_STATED: ReadonlySet<ModelBackend> = new Set([
  ModelBackend.OpenAI,
  ModelBackend.Anthropic,
  ModelBackend.Bedrock,
  ModelBackend.AWS,
]);

// The platform's Gemini key is on Google's paid API tier, which excludes training, but a user's own
// Gemini key takes precedence server-side (getEffectiveLLMApiKeys) and may be on the unpaid tier,
// which does not. The client cannot tell which key serves a call, so the line states both cases.
const GEMINI_TEXT =
  "This model is served by Google. With Bike4Mind's key, your session content is processed under Google's paid API terms, which do not use your content for training. If you use your own Google API key, your key's terms apply.";

// Ollama lists models it proxies to its own hosted service with a `cloud` tag (`gpt-oss:120b-cloud`,
// `glm-4.6:cloud`). Those leave the operator's server, so they must not get the self-hosted line.
const OLLAMA_CLOUD_TAG = /[:-]cloud$/i;

type ModelRoute = Pick<ModelInfo, 'id' | 'backend'>;

/**
 * The data-handling sentence for a model's serving route. Claims must stay within what the
 * "Model Provider Processing" section of the public privacy page (ExternalLinks.privacy) states.
 */
export const getModelDataHandlingText = (model: ModelRoute): string => {
  const provider =
    model.backend === ModelBackend.Ollama && OLLAMA_CLOUD_TAG.test(String(model.id))
      ? 'Ollama'
      : SERVING_PROVIDER[model.backend];
  if (provider === undefined) {
    return "Your session content is processed by this model's provider under its API terms.";
  }
  if (model.backend === ModelBackend.Gemini) {
    return GEMINI_TEXT;
  }
  if (provider === null) {
    return 'This model runs on a self-hosted open-weight server, so no third-party model provider processes your session content.';
  }
  if (!TRAINING_EXCLUSION_STATED.has(model.backend)) {
    return `This model is served by ${provider}. Your session content is processed by ${provider} under its API terms.`;
  }
  return `This model is served by ${provider}. Your session content is processed by ${provider} under its API terms, which do not use your content for training.`;
};

// Inline content: the caller supplies the surrounding notice row so this line matches its siblings.
export const ModelDataHandlingNotice: React.FC<{ model: ModelRoute }> = ({ model }) => (
  <span data-testid="model-details-data-handling-notice">
    {getModelDataHandlingText(model)}{' '}
    <Link
      href={ExternalLinks.privacy}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="model-details-data-handling-privacy-link"
    >
      Privacy policy
    </Link>
  </span>
);
