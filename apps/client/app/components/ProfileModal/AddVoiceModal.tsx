import {
  Alert,
  Button,
  DialogTitle,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Tooltip,
  Textarea,
  Typography,
  List,
  ListItem,
} from '@mui/joy';
import { FormEventHandler, useState } from 'react';
import { useAddNewVoice } from '../../hooks/data/voice';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import Image from 'next/image';

const AddVoiceModal = () => {
  const [open, setOpen] = useState(false);
  const [voiceId, setVoiceId] = useState<string>('');
  const [description, setDescription] = useState<string>('');

  const addVoice = useAddNewVoice({
    onSuccess: () => handleClose(),
  });

  const handleAddVoice: FormEventHandler<HTMLFormElement> = event => {
    event.preventDefault();
    addVoice.mutate({ keySpec: voiceId, description, isActive: false });
  };

  const handleClose = () => {
    setVoiceId('');
    setDescription('');
    addVoice.reset();
    setOpen(false);
  };

  return (
    <>
      <Tooltip title="Add new voice" arrow>
        <Button
          variant="outlined"
          color="neutral"
          sx={{
            alignSelf: 'start',
            gap: '.5rem',
            '&:hover': {
              backgroundColor: 'notebooklist.hoverBg',
            },
          }}
          onClick={() => setOpen(true)}
        >
          <RecordVoiceOverIcon style={{ fontSize: 16 }} />
          <span>Add New Voice</span>
        </Button>
      </Tooltip>

      <Modal open={open} onClose={handleClose}>
        <ModalDialog minWidth={400}>
          <ModalClose variant="plain" sx={{ m: 1 }} />
          <DialogTitle>
            <RecordVoiceOverIcon />
            Add New Voice
          </DialogTitle>

          <form onSubmit={handleAddVoice}>
            <Stack spacing={2}>
              <Input placeholder="Voice ID..." value={voiceId} onChange={event => setVoiceId(event.target.value)} />

              <Textarea
                placeholder="Description"
                minRows={3}
                value={description}
                onChange={event => setDescription(event.target.value)}
              />

              {addVoice.isError && <Alert color="danger">{addVoice.error?.message}</Alert>}
              {addVoice.isSuccess && <Alert color="success">API Key added successfully!</Alert>}

              <Button color="success" type="submit" disabled={addVoice.isPending}>
                Add Voice
              </Button>

              <Typography level="h3" sx={{ textAlign: 'center' }}>
                Add an Eleven Labs Voice
              </Typography>
              <Typography component="div" level="body-md" sx={{ textAlign: 'center' }}>
                <List size="sm">
                  <ListItem>1. Create an Eleven Labs Account</ListItem>
                  <ListItem>2. Navigate to your Voice Lab</ListItem>
                  <ListItem>3. Select a voice and copy the Voice ID</ListItem>
                </List>
              </Typography>
              <Image
                src={'/images/VoiceID.png'}
                alt="Logo"
                priority={true}
                width={500}
                height={262}
                style={{ width: '100%', height: 'auto' }}
              />
            </Stack>
          </form>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default AddVoiceModal;
