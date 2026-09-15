import React, { useState, useEffect, useRef } from 'react';
import {
  Button,
  Input,
  FormControl,
  Textarea,
  Checkbox,
  Modal,
  Grid,
  ModalDialog,
  Sheet,
  Tooltip,
  Stack,
  Typography,
  Divider,
  FormLabel,
  Card,
  CardContent,
  Chip,
  ChipDelete,
  RadioGroup,
  Radio,
  Box,
  IconButton,
  Alert,
  Stepper,
  Step,
  StepIndicator,
  StepButton,
  CircularProgress,
} from '@mui/joy';
import { FilePond } from 'react-filepond';
import 'filepond/dist/filepond.min.css';

const FilePondComponent = FilePond as any;
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';

import { IModal } from '@bike4mind/common';

// Icons
import CloseIcon from '@mui/icons-material/Close';
import PreviewIcon from '@mui/icons-material/Preview';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import CampaignIcon from '@mui/icons-material/Campaign';
import ImageIcon from '@mui/icons-material/Image';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import VisibilityIcon from '@mui/icons-material/Visibility';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import InfoIcon from '@mui/icons-material/Info';
import { FieldTooltip } from '@client/app/components/help';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
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

interface EditModalProps {
  isOpen: boolean;
  onClose: () => void;
  modalData: IModal | null;
  onSave: (data: IModal) => void;
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

  useEffect(() => {
    if (modalData) {
      setModalFields(modalData);
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

  const handleSave = () => {
    if (!modalFields.numberOfAgrees?.type || !modalFields.numberOfViews?.type) {
      toast.error('Please configure the view and agree counters');
      setCurrentStep(steps.findIndex(s => s.id === 'behavior'));
      return;
    }

    onSave(modalFields);
    onClose();
  };

  const renderStepContent = () => {
    const stepId = steps[currentStep].id;

    switch (stepId) {
      case 'type':
        return (
          <Card variant="soft" sx={{ p: 4, textAlign: 'center' }}>
            <Typography level="h3" sx={{ mb: 3 }}>
              What would you like to create?
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} justifyContent="center">
              <Card
                variant={!modalFields.isBanner ? 'solid' : 'outlined'}
                color={!modalFields.isBanner ? 'primary' : 'neutral'}
                sx={{
                  p: 3,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  '&:hover': { transform: 'scale(1.05)' },
                }}
                onClick={() => setModalFields(prev => ({ ...prev, isBanner: false }))}
              >
                <NotificationsActiveIcon sx={{ fontSize: 48, mb: 2 }} />
                <Typography
                  level="h4"
                  style={{
                    color: modalFields.isBanner ? undefined : 'white',
                  }}
                >
                  Modal
                </Typography>
                <Typography
                  level="body-sm"
                  sx={{ mt: 1 }}
                  style={{
                    color: modalFields.isBanner ? undefined : 'white',
                  }}
                >
                  Full-screen overlay with rich content
                </Typography>
              </Card>

              <Card
                variant={modalFields.isBanner ? 'solid' : 'outlined'}
                color={modalFields.isBanner ? 'primary' : 'neutral'}
                sx={{
                  p: 3,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  '&:hover': { transform: 'scale(1.05)' },
                }}
                onClick={() => setModalFields(prev => ({ ...prev, isBanner: true }))}
              >
                <CampaignIcon sx={{ fontSize: 48, mb: 2 }} />
                <Typography
                  level="h4"
                  style={{
                    color: modalFields.isBanner ? 'white' : undefined,
                  }}
                >
                  Banner
                </Typography>
                <Typography
                  level="body-sm"
                  sx={{ mt: 1 }}
                  style={{
                    color: modalFields.isBanner ? 'white' : undefined,
                  }}
                >
                  Subtle notification bar
                </Typography>
              </Card>
            </Stack>

            <Alert startDecorator={<InfoIcon />} color="neutral" variant="soft" sx={{ mt: 4, textAlign: 'left' }}>
              {modalFields.isBanner
                ? 'Banners are perfect for announcements and non-intrusive notifications'
                : 'Modals are great for important announcements, feature highlights, and user agreements'}
            </Alert>
          </Card>
        );

      case 'content':
        return (
          <Card variant="soft">
            <CardContent>
              <Typography level="h4" startDecorator={<TextFieldsIcon />} sx={{ mb: 3 }}>
                Modal Content
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
            </CardContent>
          </Card>
        );

      case 'banner-content':
        return (
          <Card variant="soft">
            <CardContent>
              <Typography level="h4" startDecorator={<CampaignIcon />} sx={{ mb: 3 }}>
                Banner Notification
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
            </CardContent>
          </Card>
        );

      case 'media':
        return (
          <Card variant="soft">
            <CardContent>
              <Typography level="h4" startDecorator={<ImageIcon />} sx={{ mb: 3 }}>
                Media & Images
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
                                prefix: 'modals',
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
              </Stack>
            </CardContent>
          </Card>
        );

      case 'targeting':
        return (
          <Grid container spacing={3}>
            <Grid xs={12} md={6}>
              <Card variant="soft">
                <CardContent>
                  <Typography level="h4" startDecorator={<CalendarTodayIcon />} sx={{ mb: 3 }}>
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
                      color="success"
                    />
                  </Stack>
                </CardContent>
              </Card>
            </Grid>

            <Grid xs={12} md={6}>
              <Card variant="soft">
                <CardContent>
                  <Typography level="h4" startDecorator={<GroupIcon />} sx={{ mb: 3 }}>
                    User Targeting
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
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        );

      case 'behavior':
        return (
          <Card variant="soft">
            <CardContent>
              <Typography level="h4" startDecorator={<Analytics />} sx={{ mb: 3 }}>
                Display Behavior
              </Typography>

              <Stack spacing={4}>
                <FormControl>
                  <FormLabel>Display Frequency</FormLabel>
                  <RadioGroup value={counterPreset} onChange={e => handleCounterPresetChange(e.target.value)}>
                    <Stack spacing={2}>
                      {Object.entries(COUNTER_PRESETS).map(([key, preset]) => (
                        <Card key={key} variant="outlined" sx={{ p: 2 }}>
                          <Radio value={key} label={preset.label} data-testid={`display-frequency-${key}-radio`} />
                          <Typography level="body-sm" sx={{ ml: 3.5 }}>
                            {preset.description}
                          </Typography>
                        </Card>
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
                    Counter configuration set to:{' '}
                    {COUNTER_PRESETS[counterPreset as keyof typeof COUNTER_PRESETS]?.label}
                  </Typography>
                </Alert>
              </Stack>
            </CardContent>
          </Card>
        );

      case 'review':
        return (
          <Grid container spacing={3}>
            <Grid xs={12} md={8}>
              <Card variant="soft">
                <CardContent>
                  <Typography level="h4" startDecorator={<CheckCircleIcon />} sx={{ mb: 3 }}>
                    Review Your {modalFields.isBanner ? 'Banner' : 'Modal'}
                  </Typography>

                  <Stack spacing={2}>
                    <Box>
                      <Typography level="body-sm" fontWeight="lg">
                        Type:
                      </Typography>
                      <Typography>{modalFields.isBanner ? 'Banner' : 'Modal'}</Typography>
                    </Box>

                    {!modalFields.isBanner && (
                      <>
                        <Box>
                          <Typography level="body-sm" fontWeight="lg">
                            Title:
                          </Typography>
                          <Typography>{modalFields.title || 'Not set'}</Typography>
                        </Box>
                        {modalFields.subtitle && (
                          <Box>
                            <Typography level="body-sm" fontWeight="lg">
                              Subtitle:
                            </Typography>
                            <Typography>{modalFields.subtitle}</Typography>
                          </Box>
                        )}
                      </>
                    )}

                    {modalFields.isBanner && (
                      <>
                        <Box>
                          <Typography level="body-sm" fontWeight="lg">
                            Notification Title:
                          </Typography>
                          <Typography>{modalFields.title || 'Not set'}</Typography>
                        </Box>
                        <Box>
                          <Typography level="body-sm" fontWeight="lg">
                            Banner Message:
                          </Typography>
                          <Typography>{modalFields.textMessage || 'Not set'}</Typography>
                        </Box>
                      </>
                    )}

                    <Box>
                      <Typography level="body-sm" fontWeight="lg">
                        Description:
                      </Typography>
                      <Typography>{modalFields.description || 'Not set'}</Typography>
                    </Box>

                    <Box>
                      <Typography level="body-sm" fontWeight="lg">
                        Schedule:
                      </Typography>
                      <Typography>
                        {modalFields.startDate} to {modalFields.endDate}
                      </Typography>
                    </Box>

                    <Box>
                      <Typography level="body-sm" fontWeight="lg">
                        Target Users:
                      </Typography>
                      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                        {modalFields.tags?.length ? (
                          modalFields.tags.map(tag => (
                            <Chip key={tag} size="sm" variant="solid" color="primary">
                              {tag}
                            </Chip>
                          ))
                        ) : (
                          <Typography>All users</Typography>
                        )}
                      </Stack>
                    </Box>

                    <Box>
                      <Typography level="body-sm" fontWeight="lg">
                        Options:
                      </Typography>
                      <Stack direction="row" spacing={2} sx={{ mt: 0.5 }}>
                        {modalFields.enabled && (
                          <Chip size="sm" color="success">
                            Enabled
                          </Chip>
                        )}
                        {modalFields.closeButton && <Chip size="sm">Has Close Button</Chip>}
                        {modalFields.agreeButton && <Chip size="sm">Has Agree Button</Chip>}
                      </Stack>
                    </Box>
                  </Stack>

                  <Alert color="success" variant="soft" sx={{ mt: 3 }} startDecorator={<CheckCircleIcon />}>
                    Everything looks good! Click &quot;Create&quot; to save your{' '}
                    {modalFields.isBanner ? 'banner' : 'modal'}.
                  </Alert>
                </CardContent>
              </Card>
            </Grid>

            <Grid xs={12} md={4}>
              <Card>
                <CardContent>
                  <Typography level="h4" startDecorator={<VisibilityIcon />} sx={{ mb: 2 }}>
                    Preview
                  </Typography>
                  <Button
                    fullWidth
                    variant="solid"
                    color="primary"
                    startDecorator={<PreviewIcon />}
                    onClick={() => setShowPreview(true)}
                    sx={{
                      background: 'linear-gradient(45deg, #2196F3 30%, #21CBF3 90%)',
                      boxShadow: '0 3px 5px 2px rgba(33, 203, 243, .3)',
                      transition: 'all 0.3s',
                      '&:hover': {
                        transform: 'scale(1.02)',
                        boxShadow: '0 5px 10px 3px rgba(33, 203, 243, .4)',
                      },
                    }}
                  >
                    Show Live Preview
                  </Button>

                  {modalFields.imageUrl && (
                    <Box sx={{ mt: 2, textAlign: 'center' }}>
                      <img
                        src={
                          modalFields.imageUrl.startsWith('http') && !modalFields.imageUrl.includes('amazonaws.com')
                            ? `/api/external-image?url=${encodeURIComponent(modalFields.imageUrl)}`
                            : modalFields.imageUrl
                        }
                        alt="Preview"
                        style={{ maxWidth: '100%', maxHeight: '150px', borderRadius: '8px' }}
                      />
                    </Box>
                  )}
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <Modal open={isOpen} onClose={onClose}>
        <ModalDialog layout="fullscreen">
          <Sheet sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ p: 3, borderBottom: '1px solid', borderColor: 'divider' }}
            >
              <Stack direction="row" spacing={2} alignItems="center">
                <AutoAwesomeIcon color="primary" />
                <Typography level="h2">
                  {isEditMode ? 'Edit' : 'Create'} {modalFields.isBanner ? 'Banner' : 'Modal'}
                </Typography>
              </Stack>

              <IconButton onClick={onClose} variant="plain">
                <CloseIcon />
              </IconButton>
            </Stack>

            {/* Progress Stepper */}
            <Box
              sx={{
                p: { xs: 2, sm: 3 },
                borderBottom: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.level1',
              }}
            >
              <Stepper sx={{ width: '100%' }}>
                {steps.map((step, index) => (
                  <Step
                    key={step.id}
                    indicator={
                      <StepIndicator
                        variant={index === currentStep ? 'solid' : index < currentStep ? 'soft' : 'outlined'}
                        color={index <= currentStep ? 'primary' : 'neutral'}
                      >
                        {index < currentStep ? <CheckCircleIcon /> : step.icon}
                      </StepIndicator>
                    }
                    sx={{
                      '&::after': {
                        bgcolor: index < currentStep ? 'primary.500' : 'neutral.300',
                      },
                    }}
                  >
                    <StepButton onClick={() => index < currentStep && setCurrentStep(index)}>
                      <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                        {step.label}
                      </Box>
                    </StepButton>
                  </Step>
                ))}
              </Stepper>
            </Box>

            {/* Content Area */}
            <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>{renderStepContent()}</Box>

            {/* Footer Actions */}
            <Stack
              direction={{ xs: 'column-reverse', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ xs: 'stretch', sm: 'center' }}
              spacing={{ xs: 2, sm: 0 }}
              sx={{ p: { xs: 2, sm: 3 }, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'background.level1' }}
            >
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<ArrowBackIcon />}
                onClick={handleBack}
                disabled={currentStep === 0}
              >
                Back
              </Button>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Button variant="plain" color="neutral" onClick={onClose}>
                  Cancel
                </Button>

                {currentStep === steps.length - 1 ? (
                  <Button variant="solid" color="success" startDecorator={<SaveIcon />} onClick={handleSave} size="lg">
                    {isEditMode ? 'Update' : 'Create'} {modalFields.isBanner ? 'Banner' : 'Modal'}
                  </Button>
                ) : (
                  <Button
                    variant="solid"
                    color="primary"
                    endDecorator={<ArrowForwardIcon />}
                    onClick={handleNext}
                    size="lg"
                  >
                    Next
                  </Button>
                )}
              </Stack>
            </Stack>
          </Sheet>
        </ModalDialog>
      </Modal>

      {/* Preview Modal */}
      {showPreview && (
        <>
          {isPreviewLoading ? (
            <Modal open={true} onClose={() => setShowPreview(false)}>
              <ModalDialog variant="plain" sx={{ textAlign: 'center', p: 4 }}>
                <CircularProgress size="lg" />
                <Typography level="body-lg" sx={{ mt: 2 }}>
                  Loading preview...
                </Typography>
              </ModalDialog>
            </Modal>
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
          )}
        </>
      )}
    </>
  );
};

export default EditModalNew;
