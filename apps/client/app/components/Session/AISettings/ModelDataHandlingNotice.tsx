import React from 'react';
import { Link } from '@mui/joy';
import { ModelBackend } from '@bike4mind/common';
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

/**
 * The data-handling sentence for a model's serving route. Claims must stay within what the
 * "Model Provider Processing" section of the public privacy page (ExternalLinks.privacy) states.
 */
export const getModelDataHandlingText = (backend: ModelBackend): string => {
  const provider = SERVING_PROVIDER[backend];
  if (provider === undefined) {
    return "Your session content is processed by this model's provider under its API terms.";
  }
  if (provider === null) {
    return 'This model runs on a self-hosted open-weight server, so no third-party model provider processes your session content.';
  }
  return `This model is served by ${provider}. Your session content is processed by ${provider} under its API terms, which do not use your content for training.`;
};

// Inline content: the caller supplies the surrounding notice row so this line matches its siblings.
export const ModelDataHandlingNotice: React.FC<{ backend: ModelBackend }> = ({ backend }) => (
  <span data-testid="model-details-data-handling-notice">
    {getModelDataHandlingText(backend)}{' '}
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
