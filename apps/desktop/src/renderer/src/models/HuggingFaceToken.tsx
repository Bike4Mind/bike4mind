import { useState, type FormEvent } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { HUGGING_FACE_SSH_KEYS_URL, HUGGING_FACE_TOKENS_URL, type HfTokenStatus } from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';

function TokenDialog({
  persisted,
  onSaved,
  onClose,
}: {
  persisted: boolean;
  onSaved: (status: HfTokenStatus) => void;
  onClose: () => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await window.b4m.models.setHfToken(token);
      if (result.ok) onSaved(result.status);
      else setError(result.error.message);
    } catch {
      setError('Could not save the token. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={busy ? undefined : onClose}>
      <ModalDialog size="md" sx={{ maxWidth: 520 }} data-testid="models-hf-token-dialog">
        <DialogTitle>Hugging Face token</DialogTitle>
        <form onSubmit={save}>
          <DialogContent>
            <Stack spacing={1.25}>
              <Typography level="body-sm">
                With a read token, Explore also finds and opens private repos your account can read, and can check the
                files of gated repos your account has been granted. It is sent only to huggingface.co.{' '}
                <ExternalLink href={HUGGING_FACE_TOKENS_URL} testId="models-hf-token-create-link">
                  Create a token
                </ExternalLink>
              </Typography>
              <Typography level="body-sm" data-testid="models-hf-token-ollama-note">
                Ollama does the download itself and never sees this token. For gated and private repos it signs in with
                its own key, which you add at{' '}
                <ExternalLink href={HUGGING_FACE_SSH_KEYS_URL} testId="models-hf-token-keys-link">
                  huggingface.co/settings/keys
                </ExternalLink>
                .
              </Typography>
              {!persisted && (
                <Alert size="sm" color="warning" variant="soft" data-testid="models-hf-token-no-keychain">
                  This computer has no keychain this app can use, so the token is kept only until you quit. It is never
                  written to disk in plain text.
                </Alert>
              )}
              <Input
                size="sm"
                type="password"
                autoFocus
                value={token}
                disabled={busy}
                onChange={event => setToken(event.target.value)}
                placeholder="hf_..."
                slotProps={{
                  input: {
                    'data-testid': 'models-hf-token-input',
                    'aria-label': 'Hugging Face token',
                    spellCheck: false,
                  },
                }}
              />
              {error && (
                <Alert size="sm" color="danger" variant="soft" data-testid="models-hf-token-error">
                  {error}
                </Alert>
              )}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ mt: 1.5 }}>
            <Button type="submit" loading={busy} disabled={!token.trim()} data-testid="models-hf-token-save-btn">
              Check and save
            </Button>
            <Button
              disabled={busy}
              variant="plain"
              color="neutral"
              onClick={onClose}
              data-testid="models-hf-token-cancel-btn"
            >
              Cancel
            </Button>
          </DialogActions>
        </form>
      </ModalDialog>
    </Modal>
  );
}

/** Whether a Hugging Face token is saved, and the buttons to add, replace or remove it. */
export function HuggingFaceToken({
  status,
  onChanged,
}: {
  status: HfTokenStatus | null;
  onChanged: (status: HfTokenStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  if (!status) return null;

  const remove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await window.b4m.models.clearHfToken();
      setRemoveError(result.ok ? null : result.error.message);
      if (result.ok) onChanged(result.status);
    } catch {
      setRemoveError('Could not remove the token. Try again.');
    } finally {
      setRemoving(false);
    }
  };

  const label = !status.set
    ? 'Hugging Face token: not set. Gated and private repos need one.'
    : status.persisted
      ? 'Hugging Face token: saved.'
      : 'Hugging Face token: saved until you quit (no keychain).';

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      data-testid="models-hf-token"
      data-state={status.set ? 'set' : 'unset'}
    >
      <Typography level="body-xs" textColor="text.tertiary" sx={{ flex: 1 }} data-testid="models-hf-token-status">
        {label}
      </Typography>
      {removeError && (
        <Typography level="body-xs" color="danger" data-testid="models-hf-token-remove-error">
          {removeError}
        </Typography>
      )}
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        disabled={removing}
        onClick={() => setEditing(true)}
        data-testid="models-hf-token-edit-btn"
      >
        {status.set ? 'Replace' : 'Add token'}
      </Button>
      {status.set && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          loading={removing}
          onClick={() => void remove()}
          data-testid="models-hf-token-remove-btn"
        >
          Remove
        </Button>
      )}
      {editing && (
        <TokenDialog
          persisted={status.persisted}
          onClose={() => setEditing(false)}
          onSaved={next => {
            setEditing(false);
            onChanged(next);
          }}
        />
      )}
    </Stack>
  );
}
