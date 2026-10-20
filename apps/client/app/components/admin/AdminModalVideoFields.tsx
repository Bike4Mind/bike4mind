import React, { useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Typography,
} from '@mui/joy';
import MovieIcon from '@mui/icons-material/Movie';
import ImageIcon from '@mui/icons-material/Image';
import { toast } from 'sonner';
import { KnowledgeType, type ModalVideo } from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { getS3Url } from '@client/app/utils/s3';
import { useSignedMediaUrls } from '@client/app/components/modals/useSignedMediaUrls';

type VideoField = keyof ModalVideo;

const SLOTS: { field: VideoField; slot: string; label: string; kind: 'video' | 'image' }[] = [
  { field: 'landscapeUrl', slot: 'landscape-video', label: '16:9 video (desktop)', kind: 'video' },
  { field: 'landscapePosterUrl', slot: 'landscape-poster', label: '16:9 poster', kind: 'image' },
  { field: 'portraitUrl', slot: 'portrait-video', label: '9:16 video (mobile)', kind: 'video' },
  { field: 'portraitPosterUrl', slot: 'portrait-poster', label: '9:16 poster', kind: 'image' },
];

const EMPTY_VIDEO: ModalVideo = {
  landscapeUrl: null,
  landscapePosterUrl: null,
  portraitUrl: null,
  portraitPosterUrl: null,
};

const isAcceptedFile = (kind: 'video' | 'image', file: File) =>
  kind === 'video' ? file.type === 'video/mp4' : file.type.startsWith('image/');

/** Null when every slot is empty, so a modal without a video stores `video: null`. */
export function normalizeModalVideo(video: ModalVideo): ModalVideo | null {
  const next = { ...EMPTY_VIDEO };
  for (const { field } of SLOTS) next[field] = video[field]?.trim() || null;
  return Object.values(next).some(Boolean) ? next : null;
}

interface AdminModalVideoFieldsProps {
  value: ModalVideo | null | undefined;
  onChange: (video: ModalVideo | null) => void;
  bucketName: string | undefined;
}

const AdminModalVideoFields: React.FC<AdminModalVideoFieldsProps> = ({ value, onChange, bucketName }) => {
  const video = value ?? EMPTY_VIDEO;
  const fileInputs = useRef<Partial<Record<VideoField, HTMLInputElement | null>>>({});
  const [uploading, setUploading] = useState<Partial<Record<VideoField, boolean>>>({});
  const { resolved } = useSignedMediaUrls(SLOTS.map(({ field }) => video[field]).filter((url): url is string => !!url));

  const setField = (field: VideoField, url: string | null) => onChange(normalizeModalVideo({ ...video, [field]: url }));

  const upload = async (field: VideoField, kind: 'video' | 'image', file: File) => {
    if (!isAcceptedFile(kind, file)) {
      toast.error(kind === 'video' ? 'Videos must be MP4 files' : 'Posters must be image files');
      return;
    }
    if (!bucketName) {
      toast.error('Upload bucket is not configured; paste a URL instead');
      return;
    }
    setUploading(prev => ({ ...prev, [field]: true }));
    try {
      const fabFile = await createFabFileOnServerWithUpload(
        {
          type: KnowledgeType.FILE,
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
          public: true,
          prefix: 'modals',
        },
        file
      );
      if (!fabFile.filePath) throw new Error('Upload returned no file path');
      setField(field, getS3Url({ bucket: bucketName, key: fabFile.filePath }));
    } catch (e) {
      console.error(e);
      toast.error('Failed to upload file');
    } finally {
      setUploading(prev => ({ ...prev, [field]: false }));
    }
  };

  return (
    <Stack spacing={2} data-testid="modal-video-fields">
      <Typography level="title-md" startDecorator={<MovieIcon />}>
        Product Video (optional)
      </Typography>
      <Typography level="body-sm">
        Replaces the image in the What&apos;s New slider. Desktop plays the 16:9 cut and mobile the 9:16 cut; each falls
        back to the other when only one is set.
      </Typography>
      {SLOTS.map(({ field, slot, label, kind }) => {
        const url = video[field] ?? '';
        const previewUrl = url ? resolved[url] : null;
        return (
          <FormControl key={field}>
            <FormLabel>{label}</FormLabel>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Input
                value={url}
                onChange={e => setField(field, e.target.value)}
                placeholder={kind === 'video' ? 'MP4 URL' : 'Poster image URL'}
                startDecorator={kind === 'video' ? <MovieIcon /> : <ImageIcon />}
                sx={{ flex: 1 }}
                slotProps={{ input: { 'data-testid': `modal-video-${slot}-input` } }}
              />
              <input
                ref={el => {
                  fileInputs.current[field] = el;
                }}
                type="file"
                hidden
                accept={kind === 'video' ? 'video/mp4' : 'image/*'}
                data-testid={`modal-video-${slot}-file-input`}
                onChange={e => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void upload(field, kind, file);
                }}
              />
              <Button
                variant="outlined"
                disabled={!!uploading[field]}
                startDecorator={uploading[field] ? <CircularProgress size="sm" /> : undefined}
                onClick={() => fileInputs.current[field]?.click()}
                data-testid={`modal-video-${slot}-upload-btn`}
              >
                Upload
              </Button>
              <Button
                variant="plain"
                color="neutral"
                disabled={!url}
                onClick={() => setField(field, null)}
                data-testid={`modal-video-${slot}-clear-btn`}
              >
                Clear
              </Button>
            </Stack>
            {previewUrl && (
              <Box sx={{ mt: 1 }} data-testid={`modal-video-${slot}-preview`}>
                {kind === 'video' ? (
                  <video
                    src={previewUrl}
                    muted
                    controls
                    playsInline
                    preload="metadata"
                    style={{ maxWidth: '100%', maxHeight: '160px', borderRadius: '8px' }}
                  />
                ) : (
                  <img
                    src={previewUrl}
                    alt={`${label} preview`}
                    style={{ maxWidth: '100%', maxHeight: '120px', borderRadius: '8px' }}
                  />
                )}
              </Box>
            )}
            {url && previewUrl === null && (
              <FormHelperText>Preview unavailable; a fresh upload may still be processing.</FormHelperText>
            )}
          </FormControl>
        );
      })}
    </Stack>
  );
};

export default AdminModalVideoFields;
