import React, { useState } from 'react';
import {
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Textarea,
} from '@mui/joy';
import DeleteIcon from '@mui/icons-material/Delete';
import { toast } from 'sonner';
import type { ReleaseNoteCategory, ReleaseNoteItem } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import { type AdminReleaseNote, useEditReleaseNote } from './useReleaseNotes';

const CATEGORIES: ReleaseNoteCategory[] = ['new', 'improved', 'fixed'];

interface Props {
  note: AdminReleaseNote;
  onClose: () => void;
}

const ReleaseNoteEditDialog: React.FC<Props> = ({ note, onClose }) => {
  const edit = useEditReleaseNote();
  const [headline, setHeadline] = useState(note.headline);
  const [summary, setSummary] = useState(note.summary);
  const [items, setItems] = useState<ReleaseNoteItem[]>(note.items);

  const updateItem = (index: number, patch: Partial<ReleaseNoteItem>) =>
    setItems(prev => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const onSave = () =>
    edit.mutate(
      { id: note.id, edit: { headline, summary, items } },
      {
        onSuccess: () => {
          toast.success('Release note saved');
          onClose();
        },
        onError: err => toast.error(getErrorMessage(err)),
      }
    );

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: { xs: '100%', sm: 640 }, overflowY: 'auto' }} data-testid="release-note-edit-dialog">
        <DialogTitle>Edit release notes for {note.releaseTag}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <FormControl>
              <FormLabel>Headline</FormLabel>
              <Input
                value={headline}
                onChange={event => setHeadline(event.target.value)}
                slotProps={{ input: { 'data-testid': 'release-note-edit-headline' } }}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Summary</FormLabel>
              <Textarea minRows={2} value={summary} onChange={event => setSummary(event.target.value)} />
            </FormControl>
            <FormLabel>Items</FormLabel>
            {items.map((item, index) => (
              <Stack key={index} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                <Select
                  value={item.category}
                  onChange={(_event, value) => value && updateItem(index, { category: value })}
                  sx={{ minWidth: 120 }}
                >
                  {CATEGORIES.map(category => (
                    <Option key={category} value={category}>
                      {category}
                    </Option>
                  ))}
                </Select>
                <Select
                  value={item.importance}
                  onChange={(_event, value) => value && updateItem(index, { importance: value })}
                  sx={{ minWidth: 80 }}
                  aria-label="Importance (1 is most important)"
                >
                  {[1, 2, 3].map(level => (
                    <Option key={level} value={level}>
                      {level}
                    </Option>
                  ))}
                </Select>
                <Input
                  sx={{ flex: 1 }}
                  value={item.text}
                  onChange={event => updateItem(index, { text: event.target.value })}
                />
                <IconButton
                  aria-label="Remove item"
                  onClick={() => setItems(prev => prev.filter((_item, i) => i !== index))}
                  data-testid="release-note-edit-remove-item-btn"
                >
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Button
              variant="outlined"
              onClick={() => setItems(prev => [...prev, { category: 'new', text: '', importance: 2, sourcePrs: [] }])}
              data-testid="release-note-edit-add-item-btn"
            >
              Add item
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onSave} loading={edit.isPending} data-testid="release-note-edit-save-btn">
            Save
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default ReleaseNoteEditDialog;
