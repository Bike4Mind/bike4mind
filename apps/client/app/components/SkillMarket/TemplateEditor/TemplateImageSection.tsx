import { ChangeEvent, FC, useState } from 'react';
import {
  Alert,
  AspectRatio,
  Box,
  Button,
  Chip,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  Typography,
} from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import UploadIcon from '@mui/icons-material/Upload';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { toast } from 'sonner';
import {
  KnowledgeType,
  SKILL_TEMPLATE_IMAGE_HEIGHT,
  SKILL_TEMPLATE_IMAGE_RESULT_MAX,
  SKILL_TEMPLATE_IMAGE_SOURCE_MAX_BYTES,
  SKILL_TEMPLATE_IMAGE_SOURCE_MIME_TYPES,
  SKILL_TEMPLATE_IMAGE_WIDTH,
  type SkillTemplateEditorView,
  type SkillTemplatePreviewImageStatus,
} from '@bike4mind/common';
import { useCreateFabFileWithUpload } from '@client/app/hooks/data/fabFileMutations';
import {
  useApproveSkillTemplateImage,
  useGenerateSkillTemplateImage,
  useRemoveSkillTemplateImage,
  useSetSkillTemplateImage,
} from '@client/app/hooks/data/skillTemplate';
import { getErrorMessage } from '@client/app/utils/error';

const STATUS_TEXT: Record<Exclude<SkillTemplatePreviewImageStatus, 'ready'>, string> = {
  pending: 'Checking the image. This usually takes a few seconds.',
  blocked: 'This image cannot be used. Choose another one.',
  missing: 'The image file was deleted. Add a new image.',
};

const MAX_MB = SKILL_TEMPLATE_IMAGE_SOURCE_MAX_BYTES / (1024 * 1024);

type Props = { listingId: string; view: SkillTemplateEditorView };

/** The template's preview image: upload a screenshot or generate one, then approve it. Drafts only. */
const TemplateImageSection: FC<Props> = ({ listingId, view }) => {
  const { template, previewImageUrl, previewImageStatus } = view;
  const [result, setResult] = useState('');
  const [uploading, setUploading] = useState(false);
  const createFile = useCreateFabFileWithUpload();
  const setImage = useSetSkillTemplateImage(listingId);
  const generate = useGenerateSkillTemplateImage(listingId);
  const approve = useApproveSkillTemplateImage(listingId);
  const remove = useRemoveSkillTemplateImage(listingId);

  if (!template) {
    return (
      <Typography level="body-sm" textColor="text.tertiary" data-testid="template-image-save-first">
        Save the template to add a preview image.
      </Typography>
    );
  }

  const locked = template.status !== 'draft';
  const image = template.previewImage;
  const busy = uploading || setImage.isPending || generate.isPending;

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!SKILL_TEMPLATE_IMAGE_SOURCE_MIME_TYPES.includes(file.type)) {
      toast.error('Upload a PNG or JPEG image');
      return;
    }
    if (file.size > SKILL_TEMPLATE_IMAGE_SOURCE_MAX_BYTES) {
      toast.error(`The image must be ${MAX_MB} MB or smaller`);
      return;
    }
    setUploading(true);
    try {
      const uploaded = await createFile(
        { type: KnowledgeType.FILE, fileName: file.name, mimeType: file.type, fileSize: file.size },
        file
      );
      await setImage.mutateAsync(uploaded.id);
      toast.success('Image added. Approve it before publishing.');
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const onGenerate = async () => {
    try {
      await generate.mutateAsync(result.trim());
      toast.success('Image generated. Approve it before publishing.');
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  };

  const run = (action: () => Promise<unknown>, success: string) =>
    void action()
      .then(() => toast.success(success))
      .catch(e => toast.error(getErrorMessage(e)));

  return (
    <Stack spacing={1.5} data-testid="template-image-section">
      {image ? (
        <Stack spacing={1}>
          <AspectRatio
            ratio={`${SKILL_TEMPLATE_IMAGE_WIDTH}/${SKILL_TEMPLATE_IMAGE_HEIGHT}`}
            variant="soft"
            sx={{ borderRadius: 'sm', maxWidth: 480 }}
          >
            {previewImageUrl ? (
              <img src={previewImageUrl} alt="Current preview" data-testid="template-image-current" />
            ) : (
              <Typography level="body-xs" textColor="text.tertiary" sx={{ p: 2, textAlign: 'center' }}>
                {previewImageStatus && previewImageStatus !== 'ready' ? STATUS_TEXT[previewImageStatus] : ''}
              </Typography>
            )}
          </AspectRatio>
          {previewImageStatus && previewImageStatus !== 'ready' ? (
            <Typography
              level="body-xs"
              color={previewImageStatus === 'pending' ? 'neutral' : 'danger'}
              data-testid="template-image-status"
            >
              {STATUS_TEXT[previewImageStatus]}
            </Typography>
          ) : null}
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="sm" variant="outlined" data-testid="template-image-source">
              {image.source === 'generated' ? 'Generated' : 'Uploaded'}
            </Chip>
            {image.approved ? (
              <Chip
                size="sm"
                color="success"
                variant="soft"
                startDecorator={<CheckCircleIcon />}
                data-testid="template-image-approved-chip"
              >
                Approved
              </Chip>
            ) : (
              <Button
                size="sm"
                disabled={locked || previewImageStatus !== 'ready'}
                loading={approve.isPending}
                onClick={() => run(() => approve.mutateAsync(), 'Image approved')}
                data-testid="template-image-approve-btn"
              >
                Approve image
              </Button>
            )}
            <Button
              size="sm"
              variant="plain"
              color="danger"
              disabled={locked}
              loading={remove.isPending}
              onClick={() => run(() => remove.mutateAsync(), 'Image removed')}
              data-testid="template-image-remove-btn"
            >
              Remove
            </Button>
          </Stack>
        </Stack>
      ) : (
        <Typography level="body-sm" textColor="text.tertiary">
          No preview image yet. Link previews show it when the template is shared.
        </Typography>
      )}

      {locked ? (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="template-image-locked-hint">
          Unpublish the template to change its image.
        </Typography>
      ) : (
        <Tabs defaultValue="upload" sx={{ bgcolor: 'transparent' }}>
          <TabList size="sm">
            <Tab value="upload" data-testid="template-image-upload-tab">
              Upload
            </Tab>
            <Tab value="generate" data-testid="template-image-generate-tab">
              Generate
            </Tab>
          </TabList>
          <TabPanel value="upload" sx={{ px: 0 }}>
            <Stack spacing={1}>
              <Typography level="body-xs" textColor="text.tertiary">
                A screenshot of a real result works best. PNG or JPEG up to {MAX_MB} MB; it is cropped to{' '}
                {SKILL_TEMPLATE_IMAGE_WIDTH} x {SKILL_TEMPLATE_IMAGE_HEIGHT}.
              </Typography>
              <Button
                component="label"
                size="sm"
                variant="outlined"
                startDecorator={<UploadIcon />}
                loading={uploading || setImage.isPending}
                disabled={busy}
                sx={{ alignSelf: 'flex-start' }}
              >
                Choose image
                <input
                  hidden
                  type="file"
                  accept={SKILL_TEMPLATE_IMAGE_SOURCE_MIME_TYPES.join(',')}
                  onChange={e => void onFile(e)}
                  data-testid="template-image-upload-input"
                />
              </Button>
            </Stack>
          </TabPanel>
          <TabPanel value="generate" sx={{ px: 0 }}>
            <Stack spacing={1}>
              <Textarea
                minRows={3}
                maxRows={8}
                placeholder="Paste a real result this skill produced"
                value={result}
                onChange={e => setResult(e.target.value)}
                slotProps={{
                  textarea: {
                    maxLength: SKILL_TEMPLATE_IMAGE_RESULT_MAX,
                    'data-testid': 'template-image-result-input',
                  },
                }}
              />
              <Alert size="sm" variant="soft" color="neutral" data-testid="template-image-credits-note">
                Generating uses your own credits, like any image you create.
              </Alert>
              <Box>
                <Button
                  size="sm"
                  startDecorator={<AutoAwesomeIcon />}
                  disabled={busy || !result.trim() || !template.headline.trim()}
                  loading={generate.isPending}
                  onClick={() => void onGenerate()}
                  data-testid="template-image-generate-btn"
                >
                  Generate image
                </Button>
              </Box>
              {!template.headline.trim() ? (
                <Typography level="body-xs" textColor="text.tertiary">
                  Save a headline first; the image is built from it.
                </Typography>
              ) : null}
              {generate.isPending ? (
                <Typography level="body-xs" textColor="text.tertiary" data-testid="template-image-generating">
                  Generating your image. This can take a minute.
                </Typography>
              ) : null}
            </Stack>
          </TabPanel>
        </Tabs>
      )}
    </Stack>
  );
};

export default TemplateImageSection;
