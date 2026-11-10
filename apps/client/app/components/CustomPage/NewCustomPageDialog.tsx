import { useState } from 'react';
import {
  Button,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Stack,
  Textarea,
} from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useCreateCustomPage } from '@client/app/hooks/data/customPages';

interface NewCustomPageDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function NewCustomPageDialog({ open, onClose }: NewCustomPageDialogProps) {
  const navigate = useNavigate();
  const createPage = useCreateCustomPage();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !createPage.isPending;

  const handleClose = () => {
    setName('');
    setDescription('');
    onClose();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const trimmedDescription = description.trim();
    const page = await createPage.mutateAsync({
      name: trimmedName,
      ...(trimmedDescription && { description: trimmedDescription }),
    });
    handleClose();
    navigate({ to: '/pages/$id', params: { id: page.id } } as never);
  };

  return (
    <Modal open={open} onClose={handleClose} data-testid="new-page-dialog">
      <ModalDialog sx={{ width: 'min(440px, calc(100vw - 32px))' }}>
        <DialogTitle>New page</DialogTitle>
        <DialogContent>
          <form
            onSubmit={e => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <Stack spacing={2}>
              <FormControl required>
                <FormLabel>Name</FormLabel>
                <Input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  slotProps={{ input: { 'data-testid': 'new-page-name-input', maxLength: 120 } }}
                />
              </FormControl>
              <FormControl>
                <FormLabel>Description</FormLabel>
                <Textarea
                  minRows={2}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  slotProps={{ textarea: { 'data-testid': 'new-page-description-input' } }}
                />
              </FormControl>
              <Stack direction="row" spacing={1} justifyContent="flex-end">
                <Button variant="plain" color="neutral" onClick={handleClose} data-testid="new-page-cancel-btn">
                  Cancel
                </Button>
                <Button
                  type="submit"
                  loading={createPage.isPending}
                  disabled={!canSubmit}
                  data-testid="new-page-submit-btn"
                >
                  Create
                </Button>
              </Stack>
            </Stack>
          </form>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}
