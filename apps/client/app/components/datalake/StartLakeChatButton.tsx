import { useState, type ReactNode } from 'react';
import { Button, DialogActions, DialogContent, DialogTitle, Modal, ModalDialog, Typography } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import type { DataLakeStatus } from '@bike4mind/common';
import { toast } from 'sonner';
import useStartChatWithLake from '@client/app/hooks/useStartChatWithLake';
import { usePromoteDataLake } from '@client/app/hooks/data/dataLakes';
import { isDraftLake } from '@client/app/components/datalake/lakeVisibility';

export type StartLakeChatLake = { id: string; status?: DataLakeStatus | null; canManage?: boolean };

type StartLakeChatButtonProps = {
  lake: StartLakeChatLake;
  children: ReactNode;
  startDecorator?: ReactNode;
  ariaLabel?: string;
  testId: string;
  sx?: SxProps;
};

/**
 * Opens a chat scoped to one lake (useStartChatWithLake). A draft lake does not ground answers, so it
 * confirms first and offers a manager "Publish and start chat" instead of a chat that finds nothing.
 */
export default function StartLakeChatButton({
  lake,
  children,
  startDecorator,
  ariaLabel,
  testId,
  sx,
}: StartLakeChatButtonProps) {
  const startChatWithLake = useStartChatWithLake();
  const promoteLake = usePromoteDataLake();
  const [startingChat, setStartingChat] = useState(false);
  const [draftChatOpen, setDraftChatOpen] = useState(false);

  const startChat = async (failureMessage = 'Could not start a chat with this lake') => {
    setDraftChatOpen(false);
    setStartingChat(true);
    try {
      await startChatWithLake(lake.id);
    } catch (error) {
      console.error('Start chat failed for lake', lake.id, error);
      toast.error(failureMessage);
    } finally {
      // Reset in finally, not only on error: a success that does not unmount this button
      // (e.g. navigation interrupted) would otherwise leave the spinner stuck forever.
      setStartingChat(false);
    }
  };
  const publishAndStartChat = async () => {
    try {
      await promoteLake.mutateAsync(lake.id);
    } catch {
      // usePromoteDataLake already toasted the server reason.
      return;
    }
    await startChat('Published, but could not start a chat');
  };

  return (
    <>
      <Button
        size="sm"
        variant="soft"
        color="primary"
        startDecorator={startDecorator}
        aria-label={ariaLabel}
        data-testid={testId}
        loading={startingChat}
        onClick={() => (isDraftLake({ id: lake.id, status: lake.status }) ? setDraftChatOpen(true) : void startChat())}
        sx={sx}
      >
        {children}
      </Button>
      <Modal open={draftChatOpen} onClose={() => !promoteLake.isPending && setDraftChatOpen(false)}>
        <ModalDialog data-testid="datalake-startchat-draft-modal" role="alertdialog">
          <DialogTitle>This lake is a draft</DialogTitle>
          <DialogContent>
            <Typography level="body-sm">
              Drafts don{"'"}t ground answers, so the chat will find nothing in this lake until it is published.
            </Typography>
          </DialogContent>
          <DialogActions>
            {lake.canManage && (
              <Button
                variant="solid"
                color="primary"
                data-testid="datalake-startchat-draft-publish-btn"
                loading={promoteLake.isPending}
                onClick={publishAndStartChat}
              >
                Publish and start chat
              </Button>
            )}
            <Button
              variant="soft"
              color="neutral"
              data-testid="datalake-startchat-draft-anyway-btn"
              disabled={promoteLake.isPending}
              onClick={() => void startChat()}
            >
              Start anyway
            </Button>
            <Button
              variant="plain"
              color="neutral"
              data-testid="datalake-startchat-draft-cancel-btn"
              disabled={promoteLake.isPending}
              onClick={() => setDraftChatOpen(false)}
            >
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
}
