import Typography from '@mui/joy/Typography';
import { HUGGING_FACE_SSH_KEYS_URL, type HubModelView } from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';

/**
 * What a gated or private repo needs before Ollama can pull it. Two separate credentials: the saved token lets
 * Bike4Mind read and check the files, and Ollama downloads them signed with its own SSH key.
 */
export function AccessSteps({ model }: { model: Pick<HubModelView, 'url' | 'gated' | 'private' | 'hubAccess'> }) {
  const granted = model.hubAccess === 'granted';
  return (
    <Typography component="div" level="body-sm" data-testid="models-access-steps" data-access={model.hubAccess}>
      {model.private ? 'This repo is private.' : 'This repo is gated.'} Before Ollama can download it:
      <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
        <li data-testid="models-access-step-account">
          {granted ? (
            'Your Hugging Face token can read it.'
          ) : (
            <>
              {model.private ? 'Make sure your Hugging Face account can read ' : 'Request access on '}
              <ExternalLink href={model.url} testId="models-access-repo-link">
                its Hugging Face page
              </ExternalLink>
              {model.gated === 'manual' ? ' and wait for the authors to approve it.' : '.'}
            </>
          )}
        </li>
        {model.hubAccess === 'no-token' && (
          <li data-testid="models-access-step-token">
            Add a token from that account with Add token, so Bike4Mind can check the files.
          </li>
        )}
        {model.hubAccess === 'denied' && (
          <li data-testid="models-access-step-token">
            Your saved token cannot read it yet. Once access is granted, open the repo again.
          </li>
        )}
        <li>
          Add Ollama&apos;s public key (usually <code>~/.ollama/id_ed25519.pub</code>) at{' '}
          <ExternalLink href={HUGGING_FACE_SSH_KEYS_URL} testId="models-access-keys-link">
            huggingface.co/settings/keys
          </ExternalLink>
          . Ollama downloads with this key, not with your token.
        </li>
      </ol>
    </Typography>
  );
}
