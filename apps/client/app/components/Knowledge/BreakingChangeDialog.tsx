import React from 'react';
import {
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Typography,
} from '@mui/joy';
import {
  FUNCTION_CONTRACT_GLOBAL,
  describeFunctionContractChange,
  type FunctionContractChange,
} from '@bike4mind/common';

interface BreakingChangeDialogProps {
  onClose: () => void;
  slug: string;
  pinnedVersion: number;
  /** The artifact version the update was refused for. */
  version: number;
  changes: FunctionContractChange[];
  /** The saved contract no longer parses, so the two could not be compared and `changes` is empty. */
  unreadable?: boolean;
  /** Set when the changes break the contract the tool was promoted with. */
  promotedSeq?: number | null;
}

const ChangeLine = ({ change }: { change: FunctionContractChange }) => {
  const { subject, field, words } = describeFunctionContractChange(change);
  return (
    <Typography component="li" level="body-sm" data-testid="breaking-change-dialog-change">
      {subject} {field && <code>{field}</code>} {words}
    </Typography>
  );
};

/**
 * Explains a refused Update: what in the new contract could break the tool's callers, and how to keep the tool and
 * save the new version beside it.
 */
const BreakingChangeDialog: React.FC<BreakingChangeDialogProps> = ({
  onClose,
  slug,
  pinnedVersion,
  version,
  changes,
  unreadable = false,
  promotedSeq = null,
}) => (
  <Modal open onClose={onClose}>
    <ModalDialog size="lg" data-testid="breaking-change-dialog" sx={{ width: '90%', maxWidth: 600 }}>
      <ModalClose />
      <DialogTitle>{unreadable ? 'This tool cannot be updated' : 'This update could break the tool'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {unreadable ? (
            <Typography level="body-sm" data-testid="breaking-change-dialog-unreadable">
              The saved contract cannot be read; save this version as a new tool.
            </Typography>
          ) : (
            <>
              {promotedSeq !== null ? (
                <Typography level="body-sm" data-testid="breaking-change-dialog-promoted">
                  Version {version} changes the contract of <code>{slug}</code> since promotion {promotedSeq} in ways
                  that could break its callers. A promoted tool cannot be moved to a version promotion would refuse, so
                  the tool stays pinned to version {pinnedVersion}.
                </Typography>
              ) : (
                <Typography level="body-sm">
                  Version {version} changes the contract of <code>{slug}</code> in ways that could break its callers, so
                  the tool stays pinned to version {pinnedVersion}.
                </Typography>
              )}
              <Box component="ul" sx={{ my: 0, pl: 3 }} data-testid="breaking-change-dialog-changes">
                {changes.map(change => (
                  <ChangeLine
                    key={`${change.kind}:${change.path}:${change.before ?? ''}:${change.after ?? ''}`}
                    change={change}
                  />
                ))}
              </Box>
            </>
          )}
          <Typography level="body-sm" data-testid="breaking-change-dialog-offer">
            To save version {version} as a new tool and keep <code>{slug}</code> as it is, give it a new{' '}
            <code>name</code> in <code>{FUNCTION_CONTRACT_GLOBAL}</code>, save the artifact, and select Make this a
            tool.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="solid" color="primary" onClick={onClose} data-testid="breaking-change-dialog-close-btn">
          Close
        </Button>
      </DialogActions>
    </ModalDialog>
  </Modal>
);

export default BreakingChangeDialog;
