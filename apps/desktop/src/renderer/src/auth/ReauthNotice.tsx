import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import type { AuthState } from '@shared/auth';
import { ApprovalPanel } from './SignInCard';

const DEFAULT_MESSAGE = 'Your session expired. Sign in again to continue.';

/**
 * The one notice for a session that ended while the user was working (`reauthRequired`). It
 * floats over the conversation instead of replacing it, so drafts and the paused turn survive,
 * and signs in again to the same environment; the device-flow code shows in a dialog.
 */
export function ReauthNotice({ state }: { state: AuthState }) {
  const approving = state.status === 'awaiting-approval' && !!state.pending;
  const busy = state.busy === 'signing-in' || state.busy === 'restoring';

  return (
    <>
      <Box
        sx={{
          position: 'fixed',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(560px, calc(100% - 32px))',
          zIndex: 'snackbar',
        }}
      >
        <Alert
          color="warning"
          variant="soft"
          data-testid="reauth-notice-alert"
          endDecorator={
            <Button
              size="sm"
              loading={busy}
              onClick={() => void window.b4m.auth.signIn()}
              data-testid="reauth-signin-btn"
            >
              Sign in
            </Button>
          }
        >
          {state.error?.message ?? DEFAULT_MESSAGE}
        </Alert>
      </Box>

      <Modal open={approving} onClose={() => void window.b4m.auth.cancelSignIn()}>
        <ModalDialog sx={{ width: 'min(480px, calc(100% - 32px))' }} data-testid="reauth-approval-dialog">
          {approving && <ApprovalPanel state={state} />}
        </ModalDialog>
      </Modal>
    </>
  );
}
