import Typography from '@mui/joy/Typography';
import type { HubModelView } from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';

const SSH_KEYS_URL = 'https://huggingface.co/settings/keys';

/** What a gated or private repo needs before Ollama can pull it: it signs hf.co pulls with its own SSH key. */
export function AccessSteps({ model }: { model: Pick<HubModelView, 'url' | 'gated' | 'private'> }) {
  return (
    <Typography component="div" level="body-sm" data-testid="models-access-steps">
      {model.private ? 'This repo is private.' : 'This repo is gated.'} Before Ollama can download it:
      <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
        <li>
          {model.private ? 'Make sure your Hugging Face account can read ' : 'Request access on '}
          <ExternalLink href={model.url} testId="models-access-repo-link">
            its Hugging Face page
          </ExternalLink>
          {model.gated === 'manual' ? ' and wait for the authors to approve it.' : '.'}
        </li>
        <li>
          Add Ollama&apos;s public key (usually <code>~/.ollama/id_ed25519.pub</code>) at{' '}
          <ExternalLink href={SSH_KEYS_URL} testId="models-access-keys-link">
            huggingface.co/settings/keys
          </ExternalLink>
          .
        </li>
      </ol>
    </Typography>
  );
}
