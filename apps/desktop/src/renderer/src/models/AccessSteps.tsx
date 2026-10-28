import Typography from '@mui/joy/Typography';
import type { HubModelView } from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';

const SSH_KEYS_URL = 'https://huggingface.co/settings/keys';

/**
 * What a gated or private repo needs before Ollama can pull it: it signs Hugging Face pulls with its own SSH key,
 * so for a model server (`server`) that is the server's key, not this computer's.
 */
export function AccessSteps({
  model,
  server = null,
}: {
  model: Pick<HubModelView, 'url' | 'gated' | 'private'>;
  server?: string | null;
}) {
  const keysLink = (
    <ExternalLink href={SSH_KEYS_URL} testId="models-access-keys-link">
      huggingface.co/settings/keys
    </ExternalLink>
  );
  return (
    <Typography component="div" level="body-sm" data-testid="models-access-steps">
      {model.private ? 'This repo is private.' : 'This repo is gated.'} Before{' '}
      {server ? `Ollama on ${server}` : 'Ollama'} can download it:
      <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
        <li>
          {model.private ? 'Make sure your Hugging Face account can read ' : 'Request access on '}
          <ExternalLink href={model.url} testId="models-access-repo-link">
            its Hugging Face page
          </ExternalLink>
          {model.gated === 'manual' ? ' and wait for the authors to approve it.' : '.'}
        </li>
        {server ? (
          <li data-testid="models-access-server-key">
            Add the public key of Ollama on {server}, not this computer&apos;s, at {keysLink}. On {server} it is{' '}
            <code>/usr/share/ollama/.ollama/id_ed25519.pub</code> for the Linux installer,{' '}
            <code>~/.ollama/id_ed25519.pub</code> on macOS, or <code>%USERPROFILE%\.ollama\id_ed25519.pub</code> on
            Windows. That key lets {server} read your account&apos;s private repositories and push to its repositories.
          </li>
        ) : (
          <li>
            Add Ollama&apos;s public key (usually <code>~/.ollama/id_ed25519.pub</code>) at {keysLink}.
          </li>
        )}
      </ol>
    </Typography>
  );
}
