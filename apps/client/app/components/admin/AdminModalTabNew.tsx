import React, { useState, useEffect, useRef } from 'react';
import {
  Button,
  Input,
  FormControl,
  Textarea,
  Checkbox,
  Grid,
  Tooltip,
  Stack,
  Typography,
  Divider,
  FormLabel,
  Chip,
  ChipDelete,
  RadioGroup,
  Radio,
  Box,
  Alert,
  Stepper,
  Step,
  StepIndicator,
  StepButton,
} from '@mui/joy';
import { FilePond } from 'react-filepond';
import 'filepond/dist/filepond.min.css';

const FilePondComponent = FilePond as any;
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';

import { IModal, getModalVideoErrors } from '@bike4mind/common';

// Icons
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import CampaignIcon from '@mui/icons-material/Campaign';
import ImageIcon from '@mui/icons-material/Image';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import { FieldTooltip } from '@client/app/components/help';
import GroupIcon from '@mui/icons-material/Group';
import Analytics from '@mui/icons-material/Analytics';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { KnowledgeType } from '@bike4mind/common';

import { toast } from 'sonner';
import GenericModal from '@client/app/components/modals/GenericModal';
import { getS3Url } from '@client/app/utils/s3';
import { useGetPresignedUrl } from '@client/app/hooks/data/fabFiles';
import { useConfig } from '@client/app/hooks/data/settings';
import AdminModalVideoFields from './AdminModalVideoFields';
import {
  AdminDialog,
  AdminDialogFooter,
  Fact,
  LoadingState,
  SectionCard,
  SegmentedControl,
  SettingsSection,
} from './shared';
import { videoUrlsOf } from '@client/app/components/modals/whatsNewSlideMedia';

interface EditModalProps {
  isOpen: boolean;
  onClose: () => void;
  modalData: IModal | null;
  /** Resolves once the save settles; the caller closes the wizard only on success. */
  onSave: (data: IModal) => Promise<void>;
  isEditMode: boolean;
}

const getWizardSteps = (isBanner: boolean) => {
  if (isBanner) {
    return [
      { id: 'type', label: 'Type', icon: <CampaignIcon /> },
      { id: 'banner-content', label: 'Message', icon: <TextFieldsIcon /> },
      { id: 'media', label: 'Media', icon: <ImageIcon /> },
      { id: 'targeting', label: 'Targeting', icon: <GroupIcon /> },
      { id: 'behavior', label: 'Behavior', icon: <Analytics /> },
      { id: 'review', label: 'Review', icon: <CheckCircleIcon /> },
    ];
  } else {
    return [
      { id: 'type', label: 'Type', icon: <NotificationsActiveIcon /> },
      { id: 'content', label: 'Content', icon: <TextFieldsIcon /> },
      { id: 'media', label: 'Media', icon: <ImageIcon /> },
      { id: 'targeting', label: 'Targeting', icon: <GroupIcon /> },
      { id: 'behavior', label: 'Behavior', icon: <Analytics /> },
      { id: 'review', label: 'Review', icon: <CheckCircleIcon /> },
    ];
  }
};

const TYPE_OPTIONS = [
  { value: 'modal', label: 'Modal' },
  { value: 'banner', label: 'Banner' },
] as const;

// 'whats-new' tag is managed separately in the What's New Modals admin tab
const TAG_SUGGESTIONS = [
  'new-user',
  'premium',
  'free-tier',
  'beta-tester',
  'power-user',
  'inactive',
  'trial',
  'enterprise',
];

const COUNTER_PRESETS = {
  firstTime: { label: 'First Time Only', threshold: 1, description: 'Show only once to each user' },
  weekly: { label: 'Weekly Reminder', threshold: 7, description: 'Show once per week' },
  persistent: { label: 'Persistent', threshold: 999, description: 'Keep showing until user agrees' },
  custom: { label: 'Custom', threshold: 3, description: 'Set your own threshold' },
};

const EditModalNew: React.FC<EditModalProps> = ({ isOpen, onClose, modalData, onSave, isEditMode }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [files, setFiles] = useState<any[]>([]);
  const pond = useRef(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<IModal | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [tagInput, setTagInput] = useState('');
  const [counterPreset, setCounterPreset] = useState('firstTime');
  const { mutateAsync: getPresignedUrl } = useGetPresignedUrl();
  const { data: config } = useConfig();
  const fabfileBucketName = config?.fabfileBucketName;

  const [modalFields, setModalFields] = useState<IModal>(
    () =>
      modalData || {
        title: '',
        subtitle: '',
        description: '',
        closeButton: true,
        isBanner: false,
        agreeButton: false,
        priority: 0,
        enabled: true,
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        imageUrl: '',
        images: [],
        video: null,
        textMessage: '',
        tags: [],
        numberOfAgrees: {
          type: 'firstTimeAgree',
          value: 0,
          threshold: 1,
          tags: [],
        },
        numberOfViews: {
          type: 'firstTimeView',
          value: 0,
          threshold: 1,
          tags: [],
        },
      }
  );

  const initialFields = useRef(modalFields);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Stored and uploaded video URLs pass the form check whatever their host (see AdminModalVideoFields)
  const [trustedVideoUrls, setTrustedVideoUrls] = useState<ReadonlySet<string>>(
    () => new Set(videoUrlsOf(modalData?.video))
  );

  useEffect(() => {
    if (modalData) {
      setModalFields(modalData);
      setTrustedVideoUrls(new Set(videoUrlsOf(modalData.video)));
    }
  }, [modalData]);

  // Sync counterPreset from modalFields when editing an existing modal
  useEffect(() => {
    if (modalFields.numberOfViews?.type) {
      const viewType = modalFields.numberOfViews.type;

      // Extract preset name from type (e.g., "firstTimeView" -> "firstTime")
      if (viewType.startsWith('firstTime')) {
        setCounterPreset('firstTime');
      } else if (viewType.startsWith('weekly')) {
        setCounterPreset('weekly');
      } else if (viewType.startsWith('persistent')) {
        setCounterPreset('persistent');
      } else if (viewType.startsWith('custom')) {
        setCounterPreset('custom');
      }
      // If type doesn't match any preset, keep current preset (defaults to 'firstTime')
    }
  }, [modalFields.numberOfViews?.type]);

  // Handle async preview data generation for S3 images
  useEffect(() => {
    const generatePreviewData = async () => {
      if (!showPreview) {
        setPreviewData(null);
        setIsPreviewLoading(false);
        return;
      }

      setIsPreviewLoading(true);
      try {
        const imageUrl = modalFields.imageUrl;

        // Check if it's an S3 URL that needs presigning
        if (imageUrl && imageUrl.includes('amazonaws.com') && !imageUrl.includes('/proxied-images/')) {
          const urlObj = new URL(imageUrl);
          const filePath = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
          const [presignedUrl] = await getPresignedUrl({ filePaths: [filePath], expiresIn: 3600 });

          setPreviewData({ ...modalFields, imageUrl: presignedUrl });
        } else {
          setPreviewData(modalFields);
        }
      } catch (e) {
        console.error('Error generating preview data:', e);
        setPreviewData(modalFields);
      } finally {
        setIsPreviewLoading(false);
      }
    };

    generatePreviewData();
  }, [showPreview, modalFields, getPresignedUrl]);

  const steps = getWizardSteps(modalFields.isBanner);

  const handleChange = (
    field: keyof typeof modalFields,
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const value = event.target.value;

    if (field === 'enabled' || field === 'closeButton' || field === 'agreeButton' || field === 'isBanner') {
      const checkedValue = (event.target as HTMLInputElement).checked;
      setModalFields(prev => ({ ...prev, [field]: checkedValue }));

      // Reset step when switching between modal and banner
      if (field === 'isBanner') {
        setCurrentStep(0);
      }
      return;
    }

    if (field === 'priority') {
      setModalFields(prev => ({ ...prev, [field]: parseInt(value) || 0 }));
      return;
    }

    setModalFields(prev => ({ ...prev, [field]: value }));
  };

  const handleAddTag = (tag: string) => {
    const trimmedTag = tag.trim();

    if (!trimmedTag) {
      toast.error('Tag cannot be empty');
      return;
    }

    // Validate kebab-case pattern BEFORE converting to lowercase
    const kebabCasePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!kebabCasePattern.test(trimmedTag)) {
      toast.error(
        'Tag must be in kebab-case format (lowercase letters, numbers, and hyphens only). Example: "whats-new"'
      );
      return;
    }

    // Convert to lowercase for consistency
    const normalizedTag = trimmedTag.toLowerCase();

    if (modalFields.tags?.includes(normalizedTag)) {
      toast.error(`Tag "${normalizedTag}" already added`);
      return;
    }

    setModalFields(prev => ({ ...prev, tags: [...(prev.tags || []), normalizedTag] }));
    setTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setModalFields(prev => ({
      ...prev,
      tags: prev.tags?.filter(tag => tag !== tagToRemove) || null,
    }));
  };

  const handleCounterPresetChange = (preset: string) => {
    setCounterPreset(preset);
    const presetConfig = COUNTER_PRESETS[preset as keyof typeof COUNTER_PRESETS];

    if (presetConfig) {
      setModalFields(prev => ({
        ...prev,
        numberOfViews: {
          ...prev.numberOfViews,
          value: prev.numberOfViews?.value || 0,
          threshold: presetConfig.threshold,
          type: `${preset}View`,
        },
        numberOfAgrees: {
          ...prev.numberOfAgrees,
          value: prev.numberOfAgrees?.value || 0,
          threshold: presetConfig.threshold,
          type: `${preset}Agree`,
        },
      }));
    }
  };

  // Banners have no slider slot for a video, so their video is dropped rather than validated or saved
  const hasVideoErrors = () =>
    !modalFields.isBanner &&
    Object.keys(getModalVideoErrors(modalFields.video, { allowedUrls: trustedVideoUrls })).length > 0;

  const validateCurrentStep = (): boolean => {
    const errors: Record<string, string> = {};

    switch (steps[currentStep].id) {
      case 'content':
        if (!modalFields.title) errors.title = 'Title is required';
        if (!modalFields.description) errors.description = 'Description is required';
        break;
      case 'banner-content':
        if (!modalFields.title) errors.title = 'Banner title is required';
        if (!modalFields.textMessage) errors.textMessage = 'Banner message is required';
        break;
      case 'media':
        if (hasVideoErrors()) errors.video = 'Fix the product video URLs';
        break;
      case 'targeting':
        if (!modalFields.startDate) errors.startDate = 'Start date is required';
        if (!modalFields.endDate) errors.endDate = 'End date is required';
        break;
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleNext = () => {
    if (validateCurrentStep()) {
      setCurrentStep(prev => Math.min(prev + 1, steps.length - 1));
    }
  };

  const handleBack = () => {
    setCurrentStep(prev => Math.max(prev - 1, 0));
  };

  const requestClose = () => {
    if (saving) return;
    const dirty = files.length > 0 || JSON.stringify(modalFields) !== JSON.stringify(initialFields.current);
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const handleSave = async () => {
    if (!modalFields.numberOfAgrees?.type || !modalFields.numberOfViews?.type) {
      toast.error('Please configure the view and agree counters');
      setCurrentStep(steps.findIndex(s => s.id === 'behavior'));
      return;
    }

    if (hasVideoErrors()) {
      setValidationErrors({ video: 'Fix the product video URLs' });
      setCurrentStep(steps.findIndex(s => s.id === 'media'));
      return;
    }

    setSaving(true);
    try {
      await onSave(modalFields.isBanner ? { ...modalFields, video: null } : modalFields);
    } finally {
      setSaving(false);
    }
  };

  const renderStepContent = () => {
    const stepId = steps[currentStep].id;

    switch (stepId) {
      case 'type':
        return (
          <SettingsSection>
            <Typography level="title-md" sx={{ mb: 2 }}>
              What would you like to create?
            </Typography>
            <SegmentedControl
              options={TYPE_OPTIONS}
              value={modalFields.isBanner ? 'banner' : 'modal'}
              onChange={value => setModalFields(prev => ({ ...prev, isBanner: value === 'banner' }))}
              aria-label="Type"
              data-testid="admin-modal-wizard-type"
            />
            <Typography level="body-sm" sx={{ mt: 1.5, color: 'admin.inkMuted' }}>
              {modalFields.isBanner
                ? 'A subtle notification bar, for announcements that should not interrupt.'
                : 'A full overlay with rich content, for feature highlights and user agreements.'}
            </Typography>
          </SettingsSection>
        );

      case 'content':
        return (
          <SettingsSection>
            <Typography level="title-md" sx={{ mb: 2 }}>
              Modal content
            </Typography>

            <Stack spacing={3}>
              <FormControl error={!!validationErrors.title}>
                <FormLabel>Title *</FormLabel>
                <Input
                  value={modalFields.title || ''}
                  onChange={e => handleChange('title', e)}
                  placeholder="Exciting New Feature!"
                  size="lg"
                />
                {validationErrors.title && (
                  <Typography level="body-sm" color="danger">
                    {validationErrors.title}
                  </Typography>
                )}
              </FormControl>

              <FormControl>
                <FormLabel>Subtitle</FormLabel>
                <Input
                  value={modalFields.subtitle || ''}
                  onChange={e => handleChange('subtitle', e)}
                  placeholder="Learn about our latest update"
                />
              </FormControl>

              <FormControl error={!!validationErrors.description}>
                <FormLabel>Description *</FormLabel>
                <Textarea
                  minRows={4}
                  value={modalFields.description || ''}
                  onChange={e => handleChange('description', e)}
                  placeholder="Provide detailed information about this announcement..."
                />
                {validationErrors.description && (
                  <Typography level="body-sm" color="danger">
                    {validationErrors.description}
                  </Typography>
                )}
              </FormControl>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Checkbox
                  checked={modalFields.closeButton}
                  onChange={e => handleChange('closeButton', e)}
                  label="Show close button"
                />
                <Checkbox
                  checked={modalFields.agreeButton}
                  onChange={e => handleChange('agreeButton', e)}
                  label="Include agree/acknowledge button"
                />
              </Stack>
            </Stack>
          </SettingsSection>
        );

      case 'banner-content':
        return (
          <SettingsSection>
            <Typography level="title-md" sx={{ mb: 2 }}>
              Banner notification
            </Typography>

            <Stack spacing={3}>
              <FormControl error={!!validationErrors.title}>
                <FormLabel>Notification Title *</FormLabel>
                <Tooltip title="Bold heading shown at the top of the banner (mobile notification style)">
                  <Input
                    value={modalFields.title || ''}
                    onChange={e => handleChange('title', e)}
                    placeholder="New Feature Available!"
                    size="lg"
                  />
                </Tooltip>
                {validationErrors.title && (
                  <Typography level="body-sm" color="danger">
                    {validationErrors.title}
                  </Typography>
                )}
              </FormControl>

              <FormControl error={!!validationErrors.textMessage}>
                <FormLabel>Banner Message *</FormLabel>
                <Textarea
                  minRows={2}
                  maxRows={3}
                  value={modalFields.textMessage || ''}
                  onChange={e => handleChange('textMessage', e)}
                  placeholder="Dark mode is now available for all users. Try it out in settings!"
                  startDecorator={<AutoAwesomeIcon />}
                />
                {validationErrors.textMessage && (
                  <Typography level="body-sm" color="danger">
                    {validationErrors.textMessage}
                  </Typography>
                )}
              </FormControl>

              <FormControl>
                <FormLabel>Detailed Description (Optional)</FormLabel>
                <Tooltip title="Additional details shown when user expands the banner or for admin reference">
                  <Textarea
                    minRows={3}
                    value={modalFields.description || ''}
                    onChange={e => handleChange('description', e)}
                    placeholder="Extended information or admin notes (optional)..."
                  />
                </Tooltip>
              </FormControl>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Checkbox
                  checked={modalFields.closeButton}
                  onChange={e => handleChange('closeButton', e)}
                  label="Allow dismissing"
                />
                <Checkbox
                  checked={modalFields.agreeButton}
                  onChange={e => handleChange('agreeButton', e)}
                  label="Include action button"
                />
              </Stack>
            </Stack>
          </SettingsSection>
        );

      case 'media':
        return (
          <SettingsSection>
            <Typography level="title-md" sx={{ mb: 2 }}>
              Media and images
            </Typography>

            <Stack spacing={3}>
              <FormControl>
                <FormLabel>Main Image</FormLabel>
                <FilePondComponent
                  ref={pond}
                  files={files}
                  onupdatefiles={setFiles}
                  allowMultiple={false}
                  maxFiles={1}
                  allowPaste={false}
                  acceptedFileTypes={['image/*']}
                  labelIdle={'Drag & Drop your image or <span class="filepond--label-action">Browse</span>'}
                  server={{
                    process: (
                      fieldName: string,
                      file: File,
                      metadata: any,
                      load: (fileId: string | number) => void,
                      error: (message: string) => void,
                      progress: (computable: boolean, loaded: number, total: number) => void,
                      abort: () => void
                    ) => {
                      const abortController = new AbortController();

                      file
                        .arrayBuffer()
                        .then(() => {
                          // Check if aborted during file read
                          if (abortController.signal.aborted) {
                            throw new DOMException('Upload cancelled', 'AbortError');
                          }

                          return createFabFileOnServerWithUpload(
                            {
                              type: KnowledgeType.FILE,
                              fileName: file.name,
                              mimeType: file.type,
                              fileSize: file.size,
                              public: true,
                              purpose: 'modal-media',
                            },
                            file,
                            abortController.signal
                          );
                        })
                        .then(fabFile => {
                          // Check one final time before completing
                          if (abortController.signal.aborted) {
                            throw new DOMException('Upload cancelled', 'AbortError');
                          }

                          load(fabFile.id);
                          if (fabFile.filePath && fabfileBucketName) {
                            const publicUrl = getS3Url({ bucket: fabfileBucketName, key: fabFile.filePath });
                            setModalFields(prev => ({ ...prev, imageUrl: publicUrl || '' }));
                          }
                        })
                        .catch((e: any) => {
                          // Don't show error for user-initiated cancellations
                          if (e instanceof DOMException && e.name === 'AbortError') {
                            console.log('Upload cancelled by user');
                            return; // Silent cancellation
                          }

                          console.error(e);
                          error('Failed to upload file');
                        });

                      // CRITICAL: Return abort function to FilePond
                      return {
                        abort: () => {
                          console.log('Aborting upload for file:', file.name);
                          abortController.abort();
                        },
                      };
                    },
                  }}
                />

                <Divider sx={{ my: 2 }}>OR</Divider>

                <Input
                  value={modalFields.imageUrl || ''}
                  onChange={e => handleChange('imageUrl', e)}
                  placeholder="Enter image URL directly"
                  startDecorator={<ImageIcon />}
                />
              </FormControl>

              {modalFields.imageUrl && (
                <Box sx={{ textAlign: 'center' }}>
                  <img
                    src={
                      modalFields.imageUrl.startsWith('http') && !modalFields.imageUrl.includes('amazonaws.com')
                        ? `/api/external-image?url=${encodeURIComponent(modalFields.imageUrl)}`
                        : modalFields.imageUrl
                    }
                    alt="Preview"
                    style={{ maxWidth: '100%', maxHeight: '200px', borderRadius: '8px' }}
                  />
                </Box>
              )}

              {!modalFields.isBanner && (
                <>
                  <Divider />
                  <AdminModalVideoFields
                    value={modalFields.video}
                    onChange={video => setModalFields(prev => ({ ...prev, video }))}
                    bucketName={fabfileBucketName}
                    trustedUrls={trustedVideoUrls}
                    onUploaded={url => setTrustedVideoUrls(prev => new Set(prev).add(url))}
                  />
                  {validationErrors.video && (
                    <Typography level="body-sm" color="danger" data-testid="modal-video-step-error">
                      {validationErrors.video}
                    </Typography>
                  )}
                </>
              )}
            </Stack>
          </SettingsSection>
        );

      case 'targeting':
        return (
          <Grid container spacing={3}>
            <Grid xs={12} md={6}>
              <SettingsSection sx={{ mb: 0, height: '100%' }}>
                <Typography level="title-md" sx={{ mb: 2 }}>
                  Schedule
                </Typography>

                <Stack spacing={3}>
                  <FormControl error={!!validationErrors.startDate}>
                    <FormLabel>Start Date *</FormLabel>
                    <Input
                      type="date"
                      value={modalFields.startDate || ''}
                      onChange={e => handleChange('startDate', e)}
                    />
                  </FormControl>

                  <FormControl error={!!validationErrors.endDate}>
                    <FormLabel>End Date *</FormLabel>
                    <Input type="date" value={modalFields.endDate || ''} onChange={e => handleChange('endDate', e)} />
                  </FormControl>

                  <FormControl>
                    <FormLabel>Priority</FormLabel>
                    <Input
                      type="number"
                      value={modalFields.priority}
                      onChange={e => handleChange('priority', e)}
                      startDecorator={
                        <FieldTooltip content="Higher priority modals show first" ariaLabel="Help: Priority" />
                      }
                    />
                  </FormControl>

                  <Checkbox
                    checked={modalFields.enabled}
                    onChange={e => handleChange('enabled', e)}
                    label="Enable immediately"
                  />
                </Stack>
              </SettingsSection>
            </Grid>

            <Grid xs={12} md={6}>
              <SettingsSection sx={{ mb: 0, height: '100%' }}>
                <Typography level="title-md" sx={{ mb: 2 }}>
                  User targeting
                </Typography>

                <Stack spacing={2}>
                  <FormControl>
                    <FormLabel>User Tags</FormLabel>
                    <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                      <Input
                        value={tagInput}
                        onChange={e => setTagInput(e.target.value)}
                        onKeyPress={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddTag(tagInput);
                          }
                        }}
                        placeholder="Add tag..."
                        size="sm"
                        sx={{ flex: 1 }}
                      />
                      <Button size="sm" onClick={() => handleAddTag(tagInput)} disabled={!tagInput.trim()}>
                        Add
                      </Button>
                    </Stack>

                    <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 2 }}>
                      {modalFields.tags?.map(tag => (
                        <Chip
                          key={tag}
                          variant="solid"
                          color="primary"
                          endDecorator={<ChipDelete onDelete={() => handleRemoveTag(tag)} />}
                        >
                          {tag}
                        </Chip>
                      ))}
                    </Stack>

                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      <Typography level="body-sm" sx={{ mr: 1 }}>
                        Suggestions:
                      </Typography>
                      {TAG_SUGGESTIONS.filter(tag => !modalFields.tags?.includes(tag)).map(tag => (
                        <Chip
                          key={tag}
                          variant="outlined"
                          size="sm"
                          onClick={() => handleAddTag(tag)}
                          sx={{ cursor: 'pointer' }}
                        >
                          {tag}
                        </Chip>
                      ))}
                    </Stack>
                  </FormControl>

                  <Alert color="neutral" variant="soft">
                    <Typography level="body-sm">Leave empty to show to all users</Typography>
                  </Alert>
                </Stack>
              </SettingsSection>
            </Grid>
          </Grid>
        );

      case 'behavior':
        return (
          <SettingsSection>
            <Typography level="title-md" sx={{ mb: 2 }}>
              Display behavior
            </Typography>

            <Stack spacing={4}>
              <FormControl>
                <FormLabel>Display Frequency</FormLabel>
                <RadioGroup value={counterPreset} onChange={e => handleCounterPresetChange(e.target.value)}>
                  <Stack divider={<Box sx={{ borderTop: '1px solid', borderColor: 'admin.border' }} />}>
                    {Object.entries(COUNTER_PRESETS).map(([key, preset]) => (
                      <Box key={key} sx={{ py: 1.25 }}>
                        <Radio value={key} label={preset.label} data-testid={`display-frequency-${key}-radio`} />
                        <Typography level="body-sm" sx={{ ml: 3.5, color: 'admin.inkMuted' }}>
                          {preset.description}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                </RadioGroup>
              </FormControl>

              {counterPreset === 'custom' && (
                <Stack direction="row" spacing={2}>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>View Threshold</FormLabel>
                    <Input
                      type="number"
                      value={modalFields.numberOfViews?.threshold || 0}
                      onChange={e =>
                        setModalFields(prev => ({
                          ...prev,
                          numberOfViews: {
                            ...prev.numberOfViews,
                            type: prev.numberOfViews?.type || 'customView',
                            value: prev.numberOfViews?.value || 0,
                            threshold: parseInt(e.target.value) || 0,
                          },
                        }))
                      }
                      data-testid="view-threshold-input"
                    />
                  </FormControl>

                  {modalFields.agreeButton && (
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Agree Threshold</FormLabel>
                      <Input
                        type="number"
                        value={modalFields.numberOfAgrees?.threshold || 0}
                        onChange={e =>
                          setModalFields(prev => ({
                            ...prev,
                            numberOfAgrees: {
                              ...prev.numberOfAgrees,
                              type: prev.numberOfAgrees?.type || 'customAgree',
                              value: prev.numberOfAgrees?.value || 0,
                              threshold: parseInt(e.target.value) || 0,
                            },
                          }))
                        }
                        data-testid="agree-threshold-input"
                      />
                    </FormControl>
                  )}
                </Stack>
              )}

              <Alert
                color="success"
                variant="soft"
                startDecorator={<CheckCircleIcon />}
                data-testid="counter-configuration-alert"
              >
                <Typography level="body-sm">
                  Counter configuration set to: {COUNTER_PRESETS[counterPreset as keyof typeof COUNTER_PRESETS]?.label}
                </Typography>
              </Alert>
            </Stack>
          </SettingsSection>
        );

      case 'review':
        return (
          <Grid container spacing={2}>
            <Grid xs={12} md={8}>
              <SectionCard title={`Review your ${modalFields.isBanner ? 'banner' : 'modal'}`}>
                <Fact label="Type">{modalFields.isBanner ? 'Banner' : 'Modal'}</Fact>
                {!modalFields.isBanner && (
                  <>
                    <Fact label="Title">{modalFields.title}</Fact>
                    {modalFields.subtitle && <Fact label="Subtitle">{modalFields.subtitle}</Fact>}
                  </>
                )}
                {modalFields.isBanner && (
                  <>
                    <Fact label="Notification title">{modalFields.title}</Fact>
                    <Fact label="Banner message">{modalFields.textMessage}</Fact>
                  </>
                )}
                <Fact label="Description">{modalFields.description}</Fact>
                {!modalFields.isBanner && modalFields.video && (
                  <Fact label="Video" data-testid="modal-review-video-text">
                    {[modalFields.video.landscapeUrl && '16:9', modalFields.video.portraitUrl && '9:16']
                      .filter(Boolean)
                      .join(' + ') || 'Posters only'}
                  </Fact>
                )}
                <Fact label="Schedule">
                  {modalFields.startDate} to {modalFields.endDate}
                </Fact>
                <Fact label="Target users">{modalFields.tags?.length ? modalFields.tags.join(', ') : 'All users'}</Fact>
                <Fact label="Options">
                  {[
                    modalFields.enabled && 'Enabled',
                    modalFields.closeButton && 'Close button',
                    modalFields.agreeButton && 'Agree button',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </Fact>
              </SectionCard>
            </Grid>

            <Grid xs={12} md={4}>
              <SectionCard title="Preview" body="custom">
                <Stack spacing={2} sx={{ p: 2 }}>
                  <Button variant="outlined" color="neutral" onClick={() => setShowPreview(true)}>
                    Show live preview
                  </Button>
                  {modalFields.imageUrl && (
                    <Box
                      component="img"
                      src={
                        modalFields.imageUrl.startsWith('http') && !modalFields.imageUrl.includes('amazonaws.com')
                          ? `/api/external-image?url=${encodeURIComponent(modalFields.imageUrl)}`
                          : modalFields.imageUrl
                      }
                      alt="Preview"
                      sx={{
                        maxWidth: '100%',
                        maxHeight: 150,
                        alignSelf: 'center',
                        borderRadius: 'sm',
                        border: '1px solid',
                        borderColor: 'admin.border',
                      }}
                    />
                  )}
                </Stack>
              </SectionCard>
            </Grid>
          </Grid>
        );

      default:
        return null;
    }
  };

  const noun = modalFields.isBanner ? 'banner' : 'modal';

  return (
    <>
      <AdminDialog
        open={isOpen}
        // A stray backdrop click is ignored; every other close path asks first when the draft has edits.
        onClose={reason => {
          if (reason !== 'backdropClick') requestClose();
        }}
        width={1120}
        anchorTop
        title={`${isEditMode ? 'Edit' : 'Create'} ${noun}`}
        data-testid="admin-modal-wizard-dialog"
      >
        <Stepper sx={{ width: '100%', mb: 2 }}>
          {steps.map((step, index) => (
            <Step
              key={step.id}
              indicator={
                <StepIndicator
                  variant={index <= currentStep ? 'solid' : 'outlined'}
                  sx={
                    index <= currentStep
                      ? { bgcolor: 'admin.accent', color: 'admin.surface' }
                      : { borderColor: 'admin.border', color: 'admin.inkMuted' }
                  }
                >
                  {index < currentStep ? <CheckCircleIcon /> : step.icon}
                </StepIndicator>
              }
              sx={{ '&::after': { bgcolor: index < currentStep ? 'admin.accent' : 'admin.border' } }}
            >
              <StepButton onClick={() => index < currentStep && setCurrentStep(index)}>
                <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                  {step.label}
                </Box>
              </StepButton>
            </Step>
          ))}
        </Stepper>

        {renderStepContent()}

        <Box sx={{ position: 'sticky', bottom: 0, zIndex: 1, bgcolor: 'admin.surface' }}>
          <AdminDialogFooter>
            <Button
              variant="outlined"
              color="neutral"
              onClick={handleBack}
              disabled={currentStep === 0}
              sx={{ mr: 'auto' }}
              data-testid="admin-modal-wizard-back-btn"
            >
              Back
            </Button>
            <Button variant="plain" color="neutral" onClick={requestClose} data-testid="admin-modal-wizard-cancel-btn">
              Cancel
            </Button>
            {currentStep === steps.length - 1 ? (
              <Button variant="solid" onClick={handleSave} loading={saving} data-testid="admin-modal-wizard-save-btn">
                {isEditMode ? 'Update' : 'Create'} {noun}
              </Button>
            ) : (
              <Button variant="solid" onClick={handleNext} data-testid="admin-modal-wizard-next-btn">
                Next
              </Button>
            )}
          </AdminDialogFooter>
        </Box>
      </AdminDialog>

      <AdminDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        width={420}
        title="Discard unsaved changes?"
        data-testid="admin-modal-wizard-discard-dialog"
      >
        <Typography level="body-sm">Closing discards your edits to this {noun}.</Typography>
        <AdminDialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => setConfirmDiscard(false)}
            data-testid="admin-modal-wizard-keep-btn"
          >
            Keep editing
          </Button>
          <Button
            color="danger"
            onClick={() => {
              setConfirmDiscard(false);
              onClose();
            }}
            data-testid="admin-modal-wizard-discard-btn"
          >
            Discard changes
          </Button>
        </AdminDialogFooter>
      </AdminDialog>

      {showPreview &&
        (isPreviewLoading ? (
          <AdminDialog
            onClose={() => setShowPreview(false)}
            width={360}
            title="Preview"
            data-testid="admin-modal-preview-loading-dialog"
          >
            <LoadingState label="Loading preview" />
          </AdminDialog>
        ) : (
          previewData && (
            <GenericModal
              {...previewData}
              isOpen={showPreview}
              onClose={() => setShowPreview(false)}
              onAgree={() => setShowPreview(false)}
              isPreview={true}
            />
          )
        ))}
    </>
  );
};

export default EditModalNew;
