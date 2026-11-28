import Box from '@mui/joy/Box';
import LinearProgress from '@mui/joy/LinearProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { HostInstallFailure, HostInstallProgress } from '@shared/hostConnection';
import type { HostConnectFailure } from '@shared/hostProtocol';
import { failureMessage, failureTitle, sshCommand, type HostTone } from '../host/hostPresentation';
import type { HostOperation } from '../host/hostOperations';
import { CopyMessageButton } from './CopyMessageButton';

const DOT_COLOR: Record<HostTone, string> = {
  success: 'success.solidBg',
  warning: 'warning.solidBg',
  danger: 'danger.solidBg',
  primary: 'primary.solidBg',
  neutral: 'neutral.400',
};

/** A host's state as a coloured dot; the words travel as its accessible name. */
export function HostStatusDot({ tone, label, testId }: { tone: HostTone; label: string; testId: string }) {
  return (
    <Box
      role="img"
      aria-label={label}
      data-testid={testId}
      data-tone={tone}
      sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: DOT_COLOR[tone] }}
    />
  );
}

/**
 * What went wrong, in the host's own words, with the command that reproduces it. The text is
 * rendered as text (never as markup): it comes from a remote machine.
 */
export function HostErrorDetail({
  failure,
  alias,
  testId,
}: {
  failure: HostConnectFailure | HostInstallFailure;
  alias: string | null;
  testId: string;
}) {
  const command = alias ? sshCommand(alias) : null;
  return (
    <Sheet variant="soft" color="danger" sx={{ borderRadius: 'sm', p: 1.25 }} data-testid={testId}>
      <Typography level="title-sm" data-testid={`${testId}-title`}>
        {failureTitle(failure)}
      </Typography>
      <Typography
        level="body-xs"
        component="pre"
        sx={{ m: 0, mt: 0.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace' }}
        data-testid={`${testId}-message`}
      >
        {failureMessage(failure)}
      </Typography>
      {command && (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 1 }}>
          <Typography level="body-xs">Try it yourself:</Typography>
          <Typography level="body-xs" sx={{ fontFamily: 'monospace' }} data-testid={`${testId}-command`}>
            {command}
          </Typography>
          <CopyMessageButton text={command} label="Copy ssh command" testId={`${testId}-copy-btn`} />
        </Stack>
      )}
    </Sheet>
  );
}

const PHASE_LABEL: Record<Exclude<HostInstallProgress['phase'], 'uploading' | 'done' | 'failed'>, string> = {
  preparing: 'Preparing',
  probing: 'Checking the machine',
  verifying: 'Verifying the upload',
  activating: 'Switching to the new version',
  restarting: 'Restarting the host',
};

function progressView(progress: HostInstallProgress | null): { text: string; value?: number } {
  if (!progress) return { text: 'Starting' };
  if (progress.phase === 'uploading') {
    const value = progress.totalBytes > 0 ? Math.round((progress.sentBytes / progress.totalBytes) * 100) : undefined;
    return { text: 'Uploading', ...(value === undefined ? {} : { value }) };
  }
  if (progress.phase === 'done' || progress.phase === 'failed') return { text: 'Finishing' };
  return { text: PHASE_LABEL[progress.phase] };
}

/** An install or update in flight, or the failure it ended in. Nothing for an idle host. */
export function HostOperationNotice({
  operation,
  alias,
  testId,
}: {
  operation: HostOperation;
  alias: string | null;
  testId: string;
}) {
  if (operation.status === 'running') {
    const { text, value } = progressView(operation.progress);
    return (
      <Stack spacing={0.5} data-testid={`${testId}-progress`}>
        <Typography level="body-xs">
          {operation.kind === 'install' ? 'Installing' : 'Updating'}: {text}
        </Typography>
        <LinearProgress
          determinate={value !== undefined}
          value={value ?? 0}
          size="sm"
          aria-label={`${operation.kind === 'install' ? 'Install' : 'Update'} progress`}
        />
      </Stack>
    );
  }
  if (operation.status === 'failed')
    return <HostErrorDetail failure={operation.failure} alias={alias} testId={testId} />;
  return null;
}
