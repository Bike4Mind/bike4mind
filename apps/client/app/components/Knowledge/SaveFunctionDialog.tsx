import React, { useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import {
  Alert,
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import { FUNCTION_CONTRACT_GLOBAL, type FunctionContract } from '@bike4mind/common';
import {
  callableFunctionErrorCode,
  callableFunctionErrorMessage,
  callableFunctionErrorProblems,
  callableFunctionSlugHolder,
  useCreateCallableFunction,
  useDeleteCallableFunction,
} from '@client/app/hooks/data/callableFunctions';
import FunctionProblemList, { dangerAlertSx } from './FunctionProblemList';

interface SaveFunctionDialogProps {
  open: boolean;
  /** `saved` is true once a tool was saved from this dialog. */
  onClose: (saved: boolean) => void;
  artifactId: string;
  /** The artifact version the viewer shows; the server refuses the save if the artifact has moved on. */
  version: number;
  contract: FunctionContract;
}

const FINGERPRINT_LENGTH = 12;

const countLabel = (count: number, noun: string) => (count === 1 ? `1 ${noun}` : `${count} ${noun}s`);

const ErrorAlert = ({ message }: { message: string }) => (
  <Alert color="danger" variant="solid" sx={dangerAlertSx} data-testid="save-function-dialog-error-alert">
    <Typography level="body-sm">{message}</Typography>
  </Alert>
);

function SaveError({ error, name }: { error: unknown; name: string }) {
  const code = callableFunctionErrorCode(error);
  const problems = callableFunctionErrorProblems(error);
  if (code === 'invalid_contract' && problems.length > 0) {
    return <FunctionProblemList heading="The function contract has problems:" problems={problems} />;
  }
  if (code !== 'slug_taken') {
    return <ErrorAlert message={callableFunctionErrorMessage(error, 'Could not save the tool.')} />;
  }
  if (callableFunctionSlugHolder(error)?.sourceDeleted) {
    return (
      <Alert color="warning" variant="soft" data-testid="save-function-dialog-replace-alert">
        <Typography level="body-sm">
          You already have a tool named {name}, saved from an artifact that has since been deleted. Replace it with this
          one?
        </Typography>
      </Alert>
    );
  }
  return (
    <ErrorAlert
      message={`You already have a tool named ${name}. Change the name in ${FUNCTION_CONTRACT_GLOBAL}, save the artifact, and try again.`}
    />
  );
}

const sentences = (...parts: string[]) => parts.filter(Boolean).join(' ');

/**
 * Saves the artifact's current version as a draft tool, from the Function tab. When the name belongs to a tool whose
 * artifact was deleted, offers to replace that tool: it is deleted first, then this one is saved.
 */
const SaveFunctionDialog: React.FC<SaveFunctionDialogProps> = ({ open, onClose, artifactId, version, contract }) => {
  const create = useCreateCallableFunction();
  const remove = useDeleteCallableFunction();
  // Held from the delete through the create that follows it.
  const [replacing, setReplacing] = useState(false);
  const [oldToolDeleted, setOldToolDeleted] = useState(false);
  const saving = create.isPending || replacing;
  const saved = create.data;
  const holder = oldToolDeleted ? null : callableFunctionSlugHolder(create.error);
  const replaceable = holder?.sourceDeleted ? holder : null;
  // isPending cannot stop a second click fired before the re-render commits; a second create would be refused
  // as a duplicate and replace the saved state with that error.
  const submitting = useRef(false);

  const createTool = () =>
    create.mutate(
      { artifactId, expectedVersion: version, contract },
      {
        onSettled: () => {
          submitting.current = false;
          setReplacing(false);
        },
      }
    );

  const handleSubmit = () => {
    if (submitting.current) return;
    submitting.current = true;
    createTool();
  };

  const handleReplace = async (functionId: string) => {
    if (submitting.current) return;
    submitting.current = true;
    setReplacing(true);
    try {
      await remove.mutateAsync(functionId);
      setOldToolDeleted(true);
    } catch (e) {
      // Already deleted, by another tab: the create answers with whatever holds the name now.
      if (isAxiosError(e) && e.response?.status === 404) {
        remove.reset();
      } else {
        submitting.current = false;
        setReplacing(false);
        return;
      }
    }
    createTool();
  };

  const handleClose = () => {
    if (saving) return;
    const didSave = Boolean(saved);
    create.reset();
    remove.reset();
    setOldToolDeleted(false);
    onClose(didSave);
  };

  const renderError = () => {
    if (saving) return null;
    if (remove.isError) {
      return (
        <ErrorAlert
          message={sentences('Could not delete the old tool.', callableFunctionErrorMessage(remove.error, ''))}
        />
      );
    }
    if (!create.isError) return null;
    if (oldToolDeleted) {
      return (
        <ErrorAlert
          message={sentences(
            'The old tool was deleted, but this one was not saved.',
            callableFunctionErrorMessage(create.error, ''),
            'Select Save as a draft tool to try again.'
          )}
        />
      );
    }
    return <SaveError error={create.error} name={contract.name} />;
  };
  const error = renderError();

  const rows: [string, React.ReactNode][] = [
    ['Name', <code key="name">{contract.name}</code>],
    ['Description', contract.description],
    ['Pinned version', version],
    ['Inputs', countLabel(Object.keys(contract.inputs.properties).length, 'input')],
    ['Outputs', countLabel(Object.keys(contract.outputs.properties).length, 'output')],
  ];

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog size="lg" data-testid="save-function-dialog" sx={{ width: '90%', maxWidth: 600 }}>
        <ModalClose disabled={saving} />
        <DialogTitle>Make this a tool</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography level="body-sm">
              This saves <code>{contract.name}</code> as a tool pinned to version {version} of this artifact. Later
              edits do not change the tool until you update it.
            </Typography>
            <Box sx={{ overflowX: 'auto' }}>
              <Table
                size="sm"
                borderAxis="xBetween"
                data-testid="save-function-dialog-summary"
                sx={{ tableLayout: 'auto', '& th': { bgcolor: 'transparent', whiteSpace: 'nowrap' } }}
              >
                <tbody>
                  {rows.map(([label, value]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Box>
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              Only you can call it, and your browser runs it here. Server tests, promotion, and every call to a promoted
              tool from the API, chat, or an agent run it on the server.
            </Typography>
            {saved && (
              <Alert color="success" variant="soft" data-testid="save-function-dialog-saved">
                <Stack spacing={0.5}>
                  <Typography level="title-sm">Saved as a draft tool.</Typography>
                  <Typography level="body-sm">
                    Code fingerprint: <code>{saved.pin.contentHash.slice(0, FINGERPRINT_LENGTH)}</code>
                  </Typography>
                </Stack>
              </Alert>
            )}
            {error && <div data-testid="save-function-dialog-error">{error}</div>}
          </Stack>
        </DialogContent>
        <DialogActions>
          {saved ? (
            <Button variant="solid" color="primary" onClick={handleClose} data-testid="save-function-dialog-done-btn">
              Done
            </Button>
          ) : (
            <>
              {replaceable ? (
                <Button
                  variant="solid"
                  color="primary"
                  loading={saving}
                  onClick={() => void handleReplace(replaceable.functionId)}
                  data-testid="save-function-dialog-replace-btn"
                >
                  Replace it
                </Button>
              ) : (
                <Button
                  variant="solid"
                  color="primary"
                  loading={saving}
                  onClick={handleSubmit}
                  data-testid="save-function-dialog-submit-btn"
                >
                  Save as a draft tool
                </Button>
              )}
              <Button
                variant="plain"
                color="neutral"
                onClick={handleClose}
                disabled={saving}
                data-testid="save-function-dialog-cancel-btn"
              >
                Cancel
              </Button>
            </>
          )}
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default SaveFunctionDialog;
