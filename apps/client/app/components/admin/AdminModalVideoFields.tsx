import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import prettyBytes from 'pretty-bytes';
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
import {
  KnowledgeType,
  getModalVideoErrors,
  isAllowedModalMediaUrl,
  parseStorageLimitErrorInfo,
  type ModalMediaUrlPolicy,
  type ModalVideo,
  type ModalVideoField,
} from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { getS3Url } from '@client/app/utils/s3';
import { serverStorageLimitMessage } from '@client/app/utils/storageQuota';
import { useSignedMediaUrls } from '@client/app/components/modals/useSignedMediaUrls';

const SLOTS: { field: ModalVideoField; slot: string; label: string; kind: 'video' | 'image' }[] = [
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

function uploadErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const info = parseStorageLimitErrorInfo(error.response?.data);
    if (info?.errorCode === 'file_too_large') {
      return info.limit_bytes === undefined
        ? 'File is too large for the upload size limit'
        : `File is too large: uploads are limited to ${prettyBytes(info.limit_bytes)}`;
    }
  }
  return serverStorageLimitMessage(error) ?? 'Failed to upload file';
}

const previewableUrls = (video: ModalVideo, policy: ModalMediaUrlPolicy): Partial<Record<ModalVideoField, string>> => {
  const out: Partial<Record<ModalVideoField, string>> = {};
  for (const { field } of SLOTS) {
    const url = video[field];
    if (url && isAllowedModalMediaUrl(url, policy)) out[field] = url;
  }
  return out;
};

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
  /**
   * URLs accepted whatever their host: ones this form uploaded or the modal was loaded with. The
   * browser cannot see a self-host object-store origin, so the static host list alone would reject them.
   */
  trustedUrls?: ReadonlySet<string>;
  onUploaded?: (url: string) => void;
}

const NO_TRUSTED_URLS: ReadonlySet<string> = new Set();

const AdminModalVideoFields: React.FC<AdminModalVideoFieldsProps> = ({
  value,
  onChange,
  bucketName,
  trustedUrls = NO_TRUSTED_URLS,
  onUploaded,
}) => {
  const policy: ModalMediaUrlPolicy = { allowedUrls: trustedUrls };
  const video = value ?? EMPTY_VIDEO;
  const fileInputs = useRef<Partial<Record<ModalVideoField, HTMLInputElement | null>>>({});
  const [uploading, setUploading] = useState<Partial<Record<ModalVideoField, boolean>>>({});
  // Previews follow committed URLs (blur, upload, initial value) so typing does not sign every keystroke
  const [previewed, setPreviewed] = useState(() => previewableUrls(video, policy));
  const { resolved } = useSignedMediaUrls(Object.values(previewed));
  const errors = getModalVideoErrors(video, policy);

  // An upload resolves after other edits may have landed; it must merge into the latest value
  const latest = useRef(video);
  useEffect(() => {
    latest.current = video;
  });

  const setField = (field: ModalVideoField, url: string | null) =>
    onChange(normalizeModalVideo({ ...latest.current, [field]: url }));

  const commitPreview = (field: ModalVideoField, url: string | null, uploaded = false) =>
    setPreviewed(prev => {
      const { [field]: _dropped, ...rest } = prev;
      return url && (uploaded || isAllowedModalMediaUrl(url, policy)) ? { ...rest, [field]: url } : rest;
    });

  const upload = async (field: ModalVideoField, kind: 'video' | 'image', file: File) => {
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
          purpose: 'modal-media',
        },
        file
      );
      if (!fabFile.filePath) throw new Error('Upload returned no file path');
      const url = getS3Url({ bucket: bucketName, key: fabFile.filePath });
      onUploaded?.(url);
      setField(field, url);
      commitPreview(field, url, true);
    } catch (e) {
      console.error(e);
      toast.error(uploadErrorMessage(e));
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
        back to the other when only one is set. Pasted URLs must be https on amazonaws.com or cloudfront.net.
      </Typography>
      {SLOTS.map(({ field, slot, label, kind }) => {
        const url = video[field] ?? '';
        const previewUrl = url && previewed[field] === url ? resolved[url] : undefined;
        return (
          <FormControl key={field} error={!!errors[field]}>
            <FormLabel>{label}</FormLabel>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Input
                value={url}
                onChange={e => setField(field, e.target.value)}
                onBlur={() => commitPreview(field, url)}
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
                onClick={() => {
                  setField(field, null);
                  commitPreview(field, null);
                }}
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
            {errors[field] && (
              <FormHelperText data-testid={`modal-video-${slot}-error`}>{errors[field]}</FormHelperText>
            )}
            {!errors[field] && previewUrl === null && (
              <FormHelperText>Preview unavailable; a fresh upload may still be processing.</FormHelperText>
            )}
          </FormControl>
        );
      })}
    </Stack>
  );
};

export default AdminModalVideoFields;
