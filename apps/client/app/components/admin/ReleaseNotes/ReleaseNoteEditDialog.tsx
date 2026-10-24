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
  Typography,
} from '@mui/joy';
import DeleteIcon from '@mui/icons-material/Delete';
import { toast } from 'sonner';
import type { ModalVideo, ReleaseNoteCategory, ReleaseNoteItem } from '@bike4mind/common';
import { getModalVideoErrors } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import { useConfig } from '@client/app/hooks/data/settings';
import AdminModalVideoFields from '@client/app/components/admin/AdminModalVideoFields';
import { videoUrlsOf } from '@client/app/components/modals/whatsNewSlideMedia';
import { type AdminReleaseNote, useEditReleaseNote } from './useReleaseNotes';

const VIDEO_FIELDS = ['landscapeUrl', 'landscapePosterUrl', 'portraitUrl', 'portraitPosterUrl'] as const;

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
  const [video, setVideo] = useState<ModalVideo | null>(note.video ?? null);
  // Stored and uploaded URLs pass the form check whatever their host (see AdminModalVideoFields)
  const [trustedUrls, setTrustedUrls] = useState<ReadonlySet<string>>(() => new Set(videoUrlsOf(note.video)));
  const [imageRemoved, setImageRemoved] = useState(false);
  const hasImage = Boolean(note.image?.landscapeUrl || note.image?.portraitUrl);
  const { data: config } = useConfig();
  const videoChanged = VIDEO_FIELDS.some(field => (video?.[field] ?? null) !== (note.video?.[field] ?? null));
  const videoInvalid = Object.keys(getModalVideoErrors(video, { allowedUrls: trustedUrls })).length > 0;

  const updateItem = (index: number, patch: Partial<ReleaseNoteItem>) =>
    setItems(prev => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const onSave = () =>
    edit.mutate(
      {
        id: note.id,
        edit: { headline, summary, items, ...(videoChanged && { video }), ...(imageRemoved && { image: null }) },
      },
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
                  slotProps={{ input: { 'data-testid': 'release-note-edit-item-input' } }}
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
            {hasImage && (
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Typography level="body-sm" data-testid="release-note-edit-image-status">
                  {imageRemoved ? 'Still image is removed on save' : 'Still image attached (16:9 and 9:16)'}
                </Typography>
                {!imageRemoved && (
                  <Button
                    size="sm"
                    variant="outlined"
                    color="danger"
                    onClick={() => setImageRemoved(true)}
                    data-testid="release-note-edit-remove-image-btn"
                  >
                    Remove image
                  </Button>
                )}
              </Stack>
            )}
            <AdminModalVideoFields
              value={video}
              onChange={setVideo}
              bucketName={config?.fabfileBucketName}
              trustedUrls={trustedUrls}
              onUploaded={url => setTrustedUrls(prev => new Set(prev).add(url))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={onSave}
            loading={edit.isPending}
            disabled={videoInvalid}
            data-testid="release-note-edit-save-btn"
          >
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
