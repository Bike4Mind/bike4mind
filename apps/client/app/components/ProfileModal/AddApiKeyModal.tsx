import { useAddNewApiKey } from '@client/app/hooks/data/apiKeys';
import { Alert, Button, DialogTitle, Input, Modal, ModalClose, ModalDialog, Stack, Textarea } from '@mui/joy';
import { FormEventHandler, useState } from 'react';
import KeyIcon from '@mui/icons-material/Key';
import { ApiKeyType } from '@bike4mind/common';

interface AddApiKeyModalProps {
  type: ApiKeyType;
  children: (props: { toggle: () => void }) => React.ReactNode;
}

const AddApiKeyModal = ({ type, children }: AddApiKeyModalProps) => {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState<string>('');
  const [description, setDescription] = useState<string>('');

  const addApiKey = useAddNewApiKey({
    onSuccess: () => handleClose(),
  });

  const handleAddApiKey: FormEventHandler<HTMLFormElement> = event => {
    event.preventDefault();
    addApiKey.mutate({ apiKey, type, description, isActive: false });
  };

  const handleClose = () => {
    setApiKey('');
    setDescription('');
    addApiKey.reset();
    setOpen(false);
  };

  return (
    <>
      {children({ toggle: () => setOpen(prev => !prev) })}

      <Modal open={open} onClose={handleClose}>
        <ModalDialog minWidth={400}>
          <ModalClose variant="plain" sx={{ m: 1 }} />
          <DialogTitle>
            <KeyIcon />
            Add New Key
          </DialogTitle>

          <form onSubmit={handleAddApiKey}>
            <Stack spacing={2}>
              <Input
                placeholder="Paste API Key here..."
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
              />

              <Textarea
                placeholder="Describe this API key, e.g. 'My personal OAI key.'"
                minRows={3}
                value={description}
                onChange={event => setDescription(event.target.value)}
              />

              {addApiKey.isError && <Alert color="danger">{addApiKey.error?.message}</Alert>}
              {addApiKey.isSuccess && <Alert color="success">API Key added successfully!</Alert>}

              <Button color="success" type="submit" disabled={addApiKey.isPending}>
                Add Key
              </Button>
            </Stack>
          </form>
        </ModalDialog>
      </Modal>
    </>
  );
};
export default AddApiKeyModal;
