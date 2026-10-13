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

// Backends whose providers the privacy page names (OpenAI, Anthropic) or that are AWS-hosted, and
// whose API terms exclude training by default for every key. Only these get the "do not use your
// content for training" clause. Gemini is left out because its unpaid API tier does allow training
// and the key in use may be a user's own; the AWS backend (Amazon Transcribe) is left out because
// its service improvement use is on unless the AWS account opts out.
const TRAINING_EXCLUSION_STATED: ReadonlySet<ModelBackend> = new Set([
  ModelBackend.OpenAI,
  ModelBackend.Anthropic,
  ModelBackend.Bedrock,
]);

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
