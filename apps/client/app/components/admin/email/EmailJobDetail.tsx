import { useState, useEffect, type ReactNode, useMemo, useRef } from 'react';
import {
  Box,
  Button,
  Typography,
  FormControl,
  FormLabel,
  Input,
  Textarea,
  Select,
  Option,
  Stack,
  CircularProgress,
  Sheet,
  Chip,
  Alert,
  Radio,
  RadioGroup,
  Checkbox,
  LinearProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionGroup,
  IconButton,
} from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import SendIcon from '@mui/icons-material/Send';
import ScheduleIcon from '@mui/icons-material/Schedule';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PeopleIcon from '@mui/icons-material/People';
import PersonIcon from '@mui/icons-material/Person';
import GroupIcon from '@mui/icons-material/Group';
import AlternateEmailIcon from '@mui/icons-material/AlternateEmail';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import StopIcon from '@mui/icons-material/Stop';
import CancelIcon from '@mui/icons-material/Cancel';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import {
  useEmailJob,
  useEmailTemplates,
  useEmailTemplate,
  useUpdateEmailJob,
  useCreateEmailJob,
  useCancelEmailJob,
  useScheduleEmailJob,
  usePreviewRecipients,
  useSendEmailJob,
  useCancelPendingEmails,
} from '@client/app/hooks/data/emailMarketing';
import { EmailJobStatus, EmailJobOverallStatus, IEmailTemplateDocument } from '@bike4mind/common';
import { APP_NAME } from '@client/config/general'; // brand externalized
import { getErrorMessage } from '@client/app/utils/error';
import EmailStatusSummary from './EmailStatusSummary';
import EmailActivityHistory from './EmailActivityHistory';
import EmailPreviewModal from './EmailPreviewModal';
import { parseTestEmailAddresses } from './parseTestEmailAddresses';
import { AdminDialog } from '../shared/AdminDialog';
import { DataTable, type DataColumn } from '../shared/DataTable';
import { EmptyState } from '../shared/EmptyState';

// Email attempt for Activity History
interface EmailAttempt {
  id: string;
  recipientEmail: string;
  recipientName?: string;
  status: string;
  sentAt?: Date;
  openedAt?: Date;
  clickedAt?: Date;
  errorMessage?: string;
  isTestSend?: boolean;
}

type RecipientType = 'all_users' | 'all_subscribers' | 'both' | 'specific_emails';

interface JobFormData {
  name: string;
  templateId: string;
  subject: string;
  recipientType: RecipientType;
  specificEmails: string;
  isTestMode: boolean;
  testEmailAddresses: string;
}

const initialFormData: JobFormData = {
  name: '',
  templateId: '',
  subject: '',
  recipientType: 'all_users',
  specificEmails: '',
  isTestMode: false,
  testEmailAddresses: '',
};

const RECIPIENT_TYPE_INFO: Record<RecipientType, { label: string; description: string; icon: ReactNode }> = {
  all_users: {
    label: 'All Users',
    description: 'All registered users with email addresses',
    icon: <PersonIcon />,
  },
  all_subscribers: {
    label: 'Waitlist',
    description: 'People on the waitlist (may not have accounts)',
    icon: <GroupIcon />,
  },
  both: {
    label: 'All users and waitlist',
    description: 'Both registered users and the waitlist (deduplicated)',
    icon: <PeopleIcon />,
  },
  specific_emails: {
    label: 'Specific Emails',
    description: 'Enter specific email addresses (one per line)',
    icon: <AlternateEmailIcon />,
  },
};

interface RecipientPreview {
  id: string;
  email: string;
  name?: string;
  type: 'user' | 'subscriber' | 'direct';
}

const recipientColumns: DataColumn<RecipientPreview>[] = [
  { id: 'email', label: 'Email', width: '60%', render: r => r.email },
  { id: 'name', label: 'Name', width: '40%', render: r => r.name || '-' },
];
const getRecipientId = (r: RecipientPreview) => r.email;

interface EmailJobDetailProps {
  jobId?: string; // undefined for create mode
  onBack: () => void;
}

export default function EmailJobDetail({ jobId, onBack }: EmailJobDetailProps) {
  const isEditing = !!jobId;
  const { data: job, isLoading: isLoadingJob } = useEmailJob(jobId || '');
  const { data: templates } = useEmailTemplates({ limit: 100 });

  const createMutation = useCreateEmailJob();
  const updateMutation = useUpdateEmailJob();
  const sendMutation = useSendEmailJob();
  const cancelMutation = useCancelEmailJob();
  const cancelPendingMutation = useCancelPendingEmails();
  const scheduleMutation = useScheduleEmailJob();
  const previewRecipientsMutation = usePreviewRecipients();

  const [formData, setFormData] = useState<JobFormData>(initialFormData);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [recipientPreviewData, setRecipientPreviewData] = useState<{
    totalCount: number;
    eligibleCount: number;
    excludedCount: number;
    recipients: RecipientPreview[];
    hasMore: boolean;
  } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [selectedPreviewRecipient, setSelectedPreviewRecipient] = useState<RecipientPreview | null>(null);

  // Fetch selected template for preview
  const { data: selectedTemplateData } = useEmailTemplate(formData.templateId);

  // Recipients list state
  const [viewUsersSearch, setViewUsersSearch] = useState('');
  const [viewUsersModalOpen, setViewUsersModalOpen] = useState(false);

  // Email Preview Modal state
  const [emailPreviewModalOpen, setEmailPreviewModalOpen] = useState(false);
  const [selectedAttempt, setSelectedAttempt] = useState<EmailAttempt | null>(null);

  // Full screen preview modal state
  const [fullscreenPreviewOpen, setFullscreenPreviewOpen] = useState(false);

  // Debounced specific emails for API calls (prevents excessive requests while typing)
  const [debouncedSpecificEmails, setDebouncedSpecificEmails] = useState(formData.specificEmails);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedSpecificEmails(formData.specificEmails);
    }, 500);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [formData.specificEmails]);

  // Load job data when editing
  useEffect(() => {
    if (job) {
      let recipientType: RecipientType = 'all_users';
      let specificEmails = '';

      if (job.recipientFilter?.specificEmails?.length) {
        recipientType = 'specific_emails';
        specificEmails = job.recipientFilter.specificEmails.join('\n');
      } else if (job.recipientFilter?.allUsers && job.recipientFilter?.allSubscribers) {
        recipientType = 'both';
      } else if (job.recipientFilter?.allSubscribers || job.recipientFilter?.all) {
        recipientType = 'all_subscribers';
      } else if (job.recipientFilter?.allUsers) {
        recipientType = 'all_users';
      }

      setFormData({
        name: job.name,
        templateId: job.templateId,
        subject: job.subject || '',
        recipientType,
        specificEmails,
        isTestMode: job.isTestMode || false,
        testEmailAddresses: job.testEmailAddresses?.join('\n') || '',
      });
      // Reset unsaved state when loading from server (this IS the saved state)
      setHasUnsavedChanges(false);
    }
  }, [job]);

  // Update preview when template or selected user changes
  useEffect(() => {
    if (selectedTemplateData) {
      // eslint-disable-next-line react-hooks/immutability -- updatePreview is an async preview-refresh handler called from an effect; React Compiler incorrectly flags async function calls that transition state
      updatePreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateData, formData.subject, selectedPreviewRecipient]);

  // Auto-fetch recipients when template and recipient type are set
  useEffect(() => {
    if (!formData.templateId) return;

    if (formData.recipientType === 'specific_emails') {
      // For specific_emails, use debounced value to prevent excessive API calls
      const validEmails = debouncedSpecificEmails.split(/[\n,]+/).filter(e => e.trim() && e.includes('@'));
      if (validEmails.length > 0) {
        // eslint-disable-next-line react-hooks/immutability -- handlePreviewRecipients is an async data-fetch handler called conditionally from an effect; React Compiler incorrectly flags this pattern
        handlePreviewRecipients();
      } else {
        // Clear preview when no valid emails
        setRecipientPreviewData(null);
        setSelectedPreviewRecipient(null);
      }
    } else {
      // For other recipient types, fetch immediately
      handlePreviewRecipients();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.templateId, formData.recipientType, debouncedSpecificEmails]);

  const selectedTemplate = templates?.data?.find((t: IEmailTemplateDocument) => t.id === formData.templateId);

  const updatePreview = () => {
    if (!selectedTemplateData) {
      setPreviewHtml('');
      return;
    }

    // Use selected user's data or fallback to test values
    const userName = selectedPreviewRecipient?.name || 'John Doe';
    const userEmail = selectedPreviewRecipient?.email || 'john@example.com';
    const userFirstName = selectedPreviewRecipient?.name?.split(' ')[0] || 'John';

    // Variable replacement for preview
    let html = selectedTemplateData.htmlContent;
    html = html.replace(/{{userName}}/g, userName);
    html = html.replace(/{{userFirstName}}/g, userFirstName);
    html = html.replace(/{{userEmail}}/g, userEmail);
    html = html.replace(/{{appName}}/g, APP_NAME || 'App');
    html = html.replace(/{{date}}/g, new Date().toLocaleDateString());
    html = html.replace(/{{unsubscribeUrl}}/g, '#unsubscribe');
    setPreviewHtml(html);
  };

  // Parse emails from text - supports both commas and newlines as separators
  const parseEmailList = (text: string): string[] => {
    return text
      .split(/[\n,]+/)
      .map(e => e.trim())
      .filter(e => e.length > 0 && e.includes('@'));
  };

  const buildRecipientFilter = (): {
    allUsers?: boolean;
    allSubscribers?: boolean;
    specificEmails?: string[];
  } => {
    switch (formData.recipientType) {
      case 'all_users':
        return { allUsers: true };
      case 'all_subscribers':
        return { allSubscribers: true };
      case 'both':
        return { allUsers: true, allSubscribers: true };
      case 'specific_emails':
        return { specificEmails: parseEmailList(formData.specificEmails) };
      default:
        return {};
    }
  };

  const parseTestEmails = () => parseTestEmailAddresses(formData.testEmailAddresses);

  const handleSave = async () => {
    setActionError(null);
    const recipientFilter = buildRecipientFilter();
    const testEmailAddresses = parseTestEmails();

    try {
      if (isEditing && jobId) {
        await updateMutation.mutateAsync({
          id: jobId,
          name: formData.name,
          templateId: formData.templateId,
          subject: formData.subject || undefined,
          recipientFilter,
          isTestMode: formData.isTestMode,
          testEmailAddresses: formData.isTestMode ? testEmailAddresses : undefined,
        });
      } else {
        await createMutation.mutateAsync({
          name: formData.name,
          templateId: formData.templateId,
          subject: formData.subject || undefined,
          recipientFilter,
          isTestMode: formData.isTestMode,
          testEmailAddresses: formData.isTestMode ? testEmailAddresses : undefined,
        });
        onBack();
      }
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('Failed to save campaign:', error);
      setActionError(getErrorMessage(error));
    }
  };

  const handlePreviewRecipients = async () => {
    const recipientFilter = buildRecipientFilter();

    try {
      const result = await previewRecipientsMutation.mutateAsync({
        recipientFilter,
        category: selectedTemplate?.category,
      });
      setRecipientPreviewData(result);
    } catch (error) {
      console.error('Failed to preview recipients:', error);
    }
  };

  const clearActionErrors = () => {
    setActionError(null);
    setScheduleError(null);
  };

  const handleSend = async () => {
    clearActionErrors();
    let targetJobId = jobId;
    const testEmailAddresses = parseTestEmails();
    const recipientFilter = buildRecipientFilter();

    // Auto-save before sending (create new or update existing)
    try {
      if (isEditing && jobId) {
        await updateMutation.mutateAsync({
          id: jobId,
          name: formData.name,
          templateId: formData.templateId,
          subject: formData.subject || undefined,
          recipientFilter,
          isTestMode: formData.isTestMode,
          testEmailAddresses: formData.isTestMode ? testEmailAddresses : undefined,
        });
      } else {
        const newJob = await createMutation.mutateAsync({
          name: formData.name,
          templateId: formData.templateId,
          subject: formData.subject || undefined,
          recipientFilter,
          isTestMode: formData.isTestMode,
          testEmailAddresses: formData.isTestMode ? testEmailAddresses : undefined,
        });
        targetJobId = newJob.id;
      }
      setHasUnsavedChanges(false);
    } catch (error) {
      setActionError(getErrorMessage(error));
      return;
    }

    if (!targetJobId) return;

    try {
      await sendMutation.mutateAsync({
        id: targetJobId,
        testMode: formData.isTestMode,
        testRecipients: formData.isTestMode ? testEmailAddresses : undefined,
        testSubjectIndicator: formData.isTestMode, // Only add [TEST] prefix when in test mode
        recipientFilter,
      });
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  const handleCancelPending = async () => {
    if (!jobId) return;
    clearActionErrors();
    try {
      await cancelPendingMutation.mutateAsync({ jobId });
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  const handleCancel = async () => {
    if (!jobId) return;
    clearActionErrors();
    try {
      await cancelMutation.mutateAsync(jobId);
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  // Filter recipients for View Users modal
  const filteredViewUsersRecipients = useMemo(() => {
    const recipients = recipientPreviewData?.recipients || [];
    if (!viewUsersSearch) return recipients;
    const term = viewUsersSearch.toLowerCase();
    return recipients.filter(r => r.email.toLowerCase().includes(term) || r.name?.toLowerCase().includes(term));
  }, [recipientPreviewData?.recipients, viewUsersSearch]);

  const handleSchedule = async () => {
    if (!jobId || !scheduleDate) return;
    clearActionErrors();
    try {
      await scheduleMutation.mutateAsync({
        id: jobId,
        scheduledAt: new Date(scheduleDate),
      });
      setShowSchedule(false);
    } catch (error) {
      setScheduleError(getErrorMessage(error));
    }
  };

  const getProgress = () => {
    if (!job || job.recipientCount === 0) return 0;
    return ((job.sentCount + job.failedCount) / job.recipientCount) * 100;
  };

  const isSending = job?.overallStatus === EmailJobOverallStatus.SENDING;
  // overallStatus stays non-draft once a send went out, so gate on status: the schedule route accepts only drafts.
  const canSchedule = isEditing && job?.status === EmailJobStatus.DRAFT;
  // Reusable campaigns can be edited anytime except when actively sending
  const canEdit = !job || !isSending;
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const canSave =
    formData.name &&
    formData.templateId &&
    (formData.recipientType !== 'specific_emails' || parseEmailList(formData.specificEmails).length > 0) &&
    (!formData.isTestMode || parseTestEmails().length > 0);

  // Get preview subject with variable replacement
  const previewSubject = formData.subject || selectedTemplateData?.subject || '';
  const userName = selectedPreviewRecipient?.name || 'John Doe';
  const userFirstName = selectedPreviewRecipient?.name?.split(' ')[0] || 'John';
  const userEmail = selectedPreviewRecipient?.email || 'john@example.com';
  const renderedSubject = previewSubject
    .replace(/{{userName}}/g, userName)
    .replace(/{{userFirstName}}/g, userFirstName)
    .replace(/{{userEmail}}/g, userEmail)
    .replace(/{{appName}}/g, APP_NAME || 'App')
    .replace(/{{date}}/g, new Date().toLocaleDateString());

  if (isEditing && isLoadingJob) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  const renderRecipientsEmpty = (testId: string) =>
    viewUsersSearch ? (
      <EmptyState
        title="No recipients match your search"
        action={
          <Button variant="outlined" onClick={() => setViewUsersSearch('')} data-testid={`${testId}-clear-search-btn`}>
            Clear search
          </Button>
        }
      />
    ) : (
      <EmptyState
        title="No recipients found"
        action={
          <Button
            variant="outlined"
            onClick={handlePreviewRecipients}
            loading={previewRecipientsMutation.isPending}
            data-testid={`${testId}-refresh-btn`}
          >
            Refresh recipients
          </Button>
        }
      />
    );

  // Scrolling layout - no nested scroll areas
  return (
    <Box sx={{ pb: 4 }}>
      {/* Header */}
      <Box
        data-testid="email-job-detail-header"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 1,
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.surface',
        }}
      >
        <Button variant="plain" color="neutral" startDecorator={<ArrowBackIcon />} onClick={onBack}>
          Back to Campaigns
        </Button>

        {/* Below sm the title gets its own row under Back and Save, so neither squeezes the other */}
        <Stack
          data-testid="email-job-detail-title"
          direction="row"
          alignItems="center"
          useFlexGap
          sx={{
            flexWrap: 'wrap',
            gap: 1,
            minWidth: 0,
            flex: { xs: '1 1 100%', sm: '1 1 0%' },
            order: { xs: 1, sm: 0 },
            justifyContent: { xs: 'flex-start', sm: 'center' },
            '& .MuiChip-root': { flexShrink: 0 },
          }}
        >
          <Typography level="h4" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {isEditing ? job?.name || 'Edit Campaign' : 'Create Campaign'}
          </Typography>
          {job?.overallStatus && job.overallStatus !== EmailJobOverallStatus.DRAFT && (
            <Chip
              size="sm"
              variant="soft"
              color={
                job.overallStatus === EmailJobOverallStatus.SENDING
                  ? 'warning'
                  : job.overallStatus === EmailJobOverallStatus.COMPLETE
                    ? 'success'
                    : job.overallStatus === EmailJobOverallStatus.PARTIAL
                      ? 'primary'
                      : 'danger'
              }
            >
              {job.overallStatus}
            </Chip>
          )}
          {job?.isTestMode && (
            <Chip size="sm" variant="soft" color="warning">
              TEST
            </Chip>
          )}
          {hasUnsavedChanges && (
            <Chip size="sm" color="warning">
              Unsaved
            </Chip>
          )}
        </Stack>

        <Stack data-testid="email-job-detail-actions" direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          {canEdit && (
            <Button
              data-testid="email-job-detail-save-btn"
              variant="solid"
              color="primary"
              startDecorator={<SaveIcon />}
              onClick={handleSave}
              loading={isSaving}
              disabled={!canSave}
            >
              Save
            </Button>
          )}
        </Stack>
      </Box>

      {/* Main Content - two columns from md up, stacked below so the editor never scrolls sideways */}
      <Box
        data-testid="email-job-detail-columns"
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          alignItems: 'stretch',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        {/* Left Column - Form */}
        <Box
          data-testid="email-job-detail-form-column"
          sx={{
            width: { xs: '100%', md: '50%' },
            minWidth: 0,
            p: { xs: 2, md: 3 },
            borderRight: { xs: 'none', md: '1px solid' },
            borderBottom: { xs: '1px solid', md: 'none' },
            borderColor: 'divider',
          }}
        >
          <AccordionGroup>
            {/* Campaign Details Section */}
            <Accordion defaultExpanded>
              <AccordionSummary indicator={<ExpandMoreIcon />}>
                <Typography level="title-lg">Campaign Details</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={3} sx={{ pt: 1 }}>
                  <FormControl>
                    <FormLabel>Campaign Name *</FormLabel>
                    <Input
                      value={formData.name}
                      onChange={e => {
                        setFormData({ ...formData, name: e.target.value });
                        setHasUnsavedChanges(true);
                      }}
                      placeholder="Weekly Newsletter - Dec 2024"
                      disabled={!canEdit}
                    />
                  </FormControl>

                  <FormControl>
                    <FormLabel>Template *</FormLabel>
                    <Select
                      value={formData.templateId}
                      onChange={(_, value) => {
                        setFormData({ ...formData, templateId: value as string });
                        setHasUnsavedChanges(true);
                      }}
                      placeholder="Select a template..."
                      disabled={!canEdit}
                      renderValue={option => {
                        if (!option) return null;
                        const tmpl = templates?.data?.find((t: IEmailTemplateDocument) => t.id === option.value);
                        return tmpl?.name || option.label;
                      }}
                    >
                      {templates?.data
                        ?.filter((t: IEmailTemplateDocument) => t.isActive)
                        .map((template: IEmailTemplateDocument) => (
                          <Option key={template.id} value={template.id}>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <span>{template.name}</span>
                              <Chip size="sm" variant="soft">
                                {template.category}
                              </Chip>
                            </Stack>
                          </Option>
                        ))}
                    </Select>
                  </FormControl>

                  <FormControl>
                    <FormLabel>Subject Override (Optional)</FormLabel>
                    <Input
                      value={formData.subject}
                      onChange={e => {
                        setFormData({ ...formData, subject: e.target.value });
                        setHasUnsavedChanges(true);
                      }}
                      placeholder="Leave blank to use template subject"
                      disabled={!canEdit}
                    />
                  </FormControl>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Recipients Section */}
            <Accordion defaultExpanded>
              <AccordionSummary indicator={<ExpandMoreIcon />}>
                <Typography level="title-lg">Recipients</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={3} sx={{ pt: 1 }}>
                  <RadioGroup
                    value={formData.recipientType}
                    onChange={e => {
                      setFormData({ ...formData, recipientType: e.target.value as RecipientType });
                      setHasUnsavedChanges(true);
                    }}
                  >
                    {Object.entries(RECIPIENT_TYPE_INFO).map(([value, { label, description, icon }]) => (
                      <Sheet
                        key={value}
                        variant={formData.recipientType === value ? 'soft' : 'outlined'}
                        sx={{
                          p: 2,
                          borderRadius: 'md',
                          mb: 1,
                          cursor: canEdit ? 'pointer' : 'default',
                          opacity: canEdit ? 1 : 0.7,
                          '&:hover': canEdit ? { bgcolor: 'background.level1' } : {},
                        }}
                        onClick={() => {
                          if (canEdit) {
                            setFormData({ ...formData, recipientType: value as RecipientType });
                            setHasUnsavedChanges(true);
                          }
                        }}
                      >
                        <Stack direction="row" spacing={2} alignItems="flex-start">
                          <Radio value={value} sx={{ mt: 0.5 }} disabled={!canEdit} />
                          <Box sx={{ color: 'primary.500', mt: 0.5 }}>{icon}</Box>
                          <Box>
                            <Typography level="title-sm">{label}</Typography>
                            <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                              {description}
                            </Typography>
                          </Box>
                        </Stack>
                      </Sheet>
                    ))}
                  </RadioGroup>

                  {formData.recipientType === 'specific_emails' && (
                    <FormControl>
                      <FormLabel>Email Addresses (one per line)</FormLabel>
                      <Textarea
                        value={formData.specificEmails}
                        onChange={e => {
                          setFormData({ ...formData, specificEmails: e.target.value });
                          setHasUnsavedChanges(true);
                        }}
                        placeholder="john@example.com&#10;jane@example.com&#10;..."
                        minRows={4}
                        maxRows={8}
                        disabled={!canEdit}
                      />
                      <Typography level="body-xs" sx={{ color: 'neutral.500', mt: 0.5 }}>
                        {parseEmailList(formData.specificEmails).length} valid email(s) - separate with commas or
                        newlines
                      </Typography>
                    </FormControl>
                  )}

                  {previewRecipientsMutation.isPending && !recipientPreviewData && (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <CircularProgress size="sm" />
                      <Typography level="body-sm">Loading recipients...</Typography>
                    </Stack>
                  )}

                  {recipientPreviewData && (
                    <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
                      {/* Summary Header */}
                      <Box
                        sx={{ p: 2, bgcolor: 'background.level1', borderBottom: '1px solid', borderColor: 'divider' }}
                      >
                        <Stack direction="row" spacing={3} alignItems="center">
                          <Box sx={{ textAlign: 'center' }}>
                            <Typography level="title-lg">{recipientPreviewData.totalCount}</Typography>
                            <Typography level="body-xs">Total</Typography>
                          </Box>
                          <Box sx={{ textAlign: 'center' }}>
                            <Typography level="title-lg" color="success">
                              {recipientPreviewData.eligibleCount}
                            </Typography>
                            <Typography level="body-xs">Eligible</Typography>
                          </Box>
                          <Box sx={{ textAlign: 'center' }}>
                            <Typography level="title-lg" color="warning">
                              {recipientPreviewData.excludedCount}
                            </Typography>
                            <Typography level="body-xs">Excluded</Typography>
                          </Box>
                          <Box sx={{ flex: 1 }} />
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="neutral"
                            onClick={handlePreviewRecipients}
                            loading={previewRecipientsMutation.isPending}
                            title="Refresh recipients"
                          >
                            <RefreshIcon />
                          </IconButton>
                        </Stack>
                      </Box>

                      {/* Search */}
                      <Box sx={{ p: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                        <Input
                          size="sm"
                          placeholder="Search recipients..."
                          value={viewUsersSearch}
                          onChange={e => setViewUsersSearch(e.target.value)}
                          startDecorator={<SearchIcon />}
                        />
                      </Box>

                      {/* Recipients List - Compact inline preview */}
                      <DataTable
                        label="Recipients preview"
                        testId="email-job-recipients-inline-table"
                        rows={filteredViewUsersRecipients.slice(0, 5)}
                        columns={recipientColumns}
                        getRowId={getRecipientId}
                        pagination={false}
                        framed={false}
                        // At most five rows, so the table never needs its own scroll box.
                        maxHeight="none"
                        // The form column is a fixed half of the page, so the table squeezes to fit it.
                        minWidth="0"
                        onRetry={handlePreviewRecipients}
                        empty={renderRecipientsEmpty('email-job-recipients-inline-table')}
                      />

                      {/* View All Button */}
                      {filteredViewUsersRecipients.length > 5 && (
                        <Box sx={{ p: 1.5, textAlign: 'center', borderTop: '1px solid', borderColor: 'divider' }}>
                          <Button
                            size="sm"
                            variant="soft"
                            color="primary"
                            startDecorator={<PeopleIcon />}
                            onClick={() => setViewUsersModalOpen(true)}
                          >
                            View All {filteredViewUsersRecipients.length} Recipients
                          </Button>
                        </Box>
                      )}
                    </Sheet>
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Test Mode Section */}
            <Accordion defaultExpanded>
              <AccordionSummary indicator={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography level="title-lg">Test Mode</Typography>
                  {formData.isTestMode && (
                    <Chip size="sm" color="warning">
                      Enabled
                    </Chip>
                  )}
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={2} sx={{ pt: 1 }}>
                  <Checkbox
                    label="Enable Test Mode"
                    checked={formData.isTestMode}
                    onChange={e => {
                      setFormData({ ...formData, isTestMode: e.target.checked });
                      setHasUnsavedChanges(true);
                    }}
                    disabled={!canEdit}
                  />
                  <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
                    When enabled, emails are composed for the actual recipients (to preview personalization) but
                    delivered to the test address below instead. Subject will be prefixed with [TEST].
                  </Typography>

                  {formData.isTestMode && (
                    <>
                      <FormControl>
                        <FormLabel>Test Email Addresses (one per line)</FormLabel>
                        <Textarea
                          value={formData.testEmailAddresses}
                          onChange={e => {
                            setFormData({ ...formData, testEmailAddresses: e.target.value });
                            setHasUnsavedChanges(true);
                          }}
                          placeholder="test@example.com&#10;qa@example.com&#10;..."
                          minRows={3}
                          maxRows={6}
                          disabled={!canEdit}
                        />
                        <Typography level="body-xs" sx={{ color: 'neutral.500', mt: 0.5 }}>
                          {parseTestEmails().length} valid test email(s)
                        </Typography>
                      </FormControl>

                      <Alert color="warning" variant="soft">
                        Test Mode is enabled.{' '}
                        {Math.min(recipientPreviewData?.eligibleCount || 0, parseTestEmails().length)} test email(s)
                        will be sent (one per test address below), composed using real recipient data for a
                        personalization preview.
                      </Alert>
                    </>
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Send Campaign Section - Available in both create and edit modes */}
            <Accordion defaultExpanded>
              <AccordionSummary indicator={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography level="title-lg">Send Campaign</Typography>
                  {isSending && (
                    <Chip size="sm" color="warning" variant="soft">
                      Sending...
                    </Chip>
                  )}
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={3} sx={{ pt: 1 }}>
                  {/* Sending Alert - Lock message */}
                  {isSending && (
                    <Alert color="warning" variant="soft">
                      Campaign is actively sending. Editing is disabled. You can cancel pending emails if needed.
                    </Alert>
                  )}

                  {/* Current Status - Only show if job exists */}
                  {isEditing && job && (
                    <Sheet variant="soft" sx={{ p: 2, borderRadius: 'md' }}>
                      <Stack spacing={2}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center">
                          <Typography level="title-sm">Campaign Status</Typography>
                          {job.overallStatus && job.overallStatus !== EmailJobOverallStatus.DRAFT && (
                            <Chip
                              size="sm"
                              variant="soft"
                              color={
                                job.overallStatus === EmailJobOverallStatus.SENDING
                                  ? 'warning'
                                  : job.overallStatus === EmailJobOverallStatus.COMPLETE
                                    ? 'success'
                                    : job.overallStatus === EmailJobOverallStatus.PARTIAL
                                      ? 'primary'
                                      : 'danger'
                              }
                            >
                              {job.overallStatus}
                            </Chip>
                          )}
                        </Stack>

                        {job.lastSentAt && (
                          <Typography level="body-sm">
                            Last sent: {new Date(job.lastSentAt).toLocaleString()}
                          </Typography>
                        )}

                        {job.recipientCount > 0 && job.status !== EmailJobStatus.DRAFT && (
                          <>
                            <LinearProgress determinate value={getProgress()} />
                            <Typography level="body-sm">
                              {job.sentCount + job.failedCount} / {job.recipientCount} processed
                              {job.failedCount > 0 && (
                                <Typography component="span" color="danger">
                                  {' '}
                                  ({job.failedCount} failed)
                                </Typography>
                              )}
                            </Typography>
                          </>
                        )}
                      </Stack>
                    </Sheet>
                  )}

                  {/* Send Buttons */}
                  <Stack direction="row" spacing={2} flexWrap="wrap">
                    {/* Send Campaign - Auto-saves if needed */}
                    {!isSending && (
                      <Button
                        variant="solid"
                        color="success"
                        startDecorator={<SendIcon />}
                        onClick={handleSend}
                        loading={sendMutation.isPending || createMutation.isPending || updateMutation.isPending}
                        disabled={!canSave || !recipientPreviewData?.eligibleCount}
                      >
                        {formData.isTestMode ? 'Send Test' : 'Send Campaign'}
                        {(hasUnsavedChanges || !isEditing) && ' (Save & Send)'}
                      </Button>
                    )}

                    {canSchedule && !isSending && (
                      <Button
                        variant="soft"
                        color="primary"
                        startDecorator={<ScheduleIcon />}
                        onClick={() => {
                          const defaultDate = new Date();
                          defaultDate.setHours(defaultDate.getHours() + 1);
                          defaultDate.setMinutes(0, 0, 0);
                          setScheduleDate(defaultDate.toISOString().slice(0, 16));
                          setScheduleError(null);
                          setShowSchedule(true);
                        }}
                      >
                        Schedule
                      </Button>
                    )}

                    {/* Cancel - When actively sending */}
                    {isEditing && job && isSending && (
                      <Button
                        variant="solid"
                        color="danger"
                        startDecorator={<CancelIcon />}
                        onClick={handleCancelPending}
                        loading={cancelPendingMutation.isPending}
                      >
                        Cancel All Pending
                      </Button>
                    )}

                    {isEditing && job && job.status === EmailJobStatus.SCHEDULED && (
                      <Button
                        variant="soft"
                        color="danger"
                        startDecorator={<StopIcon />}
                        onClick={handleCancel}
                        loading={cancelMutation.isPending}
                      >
                        Cancel Schedule
                      </Button>
                    )}
                  </Stack>

                  {actionError && (
                    <Alert color="danger" variant="soft" data-testid="email-job-action-error">
                      {actionError}
                    </Alert>
                  )}

                  {/* A rejected schedule refetches the job; if it is no longer a draft the form below is gone. */}
                  {!canSchedule && scheduleError && (
                    <Alert color="danger" variant="soft" data-testid="email-job-schedule-error">
                      {scheduleError}
                    </Alert>
                  )}

                  {/* Recipient count reminder */}
                  {recipientPreviewData && (
                    <Alert color="primary" variant="soft">
                      {formData.isTestMode
                        ? `Will send ${Math.min(recipientPreviewData.eligibleCount, parseTestEmails().length)} test email(s) (one per test address)`
                        : `Will send to ${recipientPreviewData.eligibleCount} recipients`}
                    </Alert>
                  )}

                  {canSchedule && showSchedule && (
                    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md' }}>
                      <Stack spacing={2}>
                        <FormControl>
                          <FormLabel>Send At</FormLabel>
                          <Input
                            type="datetime-local"
                            value={scheduleDate}
                            onChange={e => setScheduleDate(e.target.value)}
                            slotProps={{
                              input: {
                                min: new Date().toISOString().slice(0, 16),
                              },
                            }}
                          />
                        </FormControl>
                        {scheduleError && (
                          <Alert color="danger" variant="soft" data-testid="email-job-schedule-error">
                            {scheduleError}
                          </Alert>
                        )}
                        <Stack direction="row" spacing={1}>
                          <Button
                            variant="solid"
                            color="primary"
                            startDecorator={<ScheduleIcon />}
                            onClick={handleSchedule}
                            loading={scheduleMutation.isPending}
                            disabled={!scheduleDate || new Date(scheduleDate) <= new Date()}
                          >
                            Schedule
                          </Button>
                          <Button
                            variant="plain"
                            color="neutral"
                            onClick={() => {
                              setShowSchedule(false);
                              setScheduleError(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </Stack>
                      </Stack>
                    </Sheet>
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </AccordionGroup>
        </Box>

        {/* Right Column - Preview */}
        <Box
          data-testid="email-job-detail-preview-column"
          sx={{
            width: { xs: '100%', md: '50%' },
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'background.level1',
          }}
        >
          <Box
            data-testid="email-job-detail-preview-header"
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              p: 2,
              borderBottom: '1px solid',
              borderColor: 'divider',
              gap: 2,
              flexShrink: 0,
            }}
          >
            <Typography level="title-md" sx={{ flexShrink: 0 }}>
              Email Preview
            </Typography>

            {/* Recipient Selection for Variable Testing */}
            <Select
              data-testid="email-job-detail-recipient-select"
              size="sm"
              placeholder={
                recipientPreviewData
                  ? `Select recipient (${recipientPreviewData.eligibleCount} total)...`
                  : 'Loading recipients...'
              }
              disabled={!recipientPreviewData || recipientPreviewData.recipients.length === 0}
              value={selectedPreviewRecipient?.email || ''}
              onChange={(_, value) => {
                const recipient = recipientPreviewData?.recipients.find(r => r.email === value);
                setSelectedPreviewRecipient(recipient || null);
              }}
              sx={{ minWidth: { xs: '100%', sm: 250 }, flex: 1, maxWidth: 350 }}
            >
              {recipientPreviewData?.recipients.map(recipient => (
                <Option key={recipient.email} value={recipient.email}>
                  {recipient.email}
                  {recipient.name ? ` - ${recipient.name}` : ''}
                </Option>
              ))}
              {recipientPreviewData?.hasMore && (
                <Option disabled value="__more__">
                  ... and {recipientPreviewData.eligibleCount - recipientPreviewData.recipients.length} more
                </Option>
              )}
            </Select>

            <Stack direction="row" spacing={1}>
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={<RefreshIcon />}
                onClick={updatePreview}
                disabled={!formData.templateId}
              >
                Refresh
              </Button>
              <IconButton
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => setFullscreenPreviewOpen(true)}
                disabled={!previewHtml}
                title="Full screen preview"
                data-testid="email-job-fullscreen-btn"
              >
                <FullscreenIcon />
              </IconButton>
            </Stack>
          </Box>

          {/* Subject Preview */}
          {formData.templateId && (
            <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.surface' }}>
              {selectedPreviewRecipient && (
                <Chip size="sm" variant="soft" color="primary" sx={{ mb: 1 }}>
                  Previewing as: {selectedPreviewRecipient.name || selectedPreviewRecipient.email}
                </Chip>
              )}
              <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 0.5 }}>
                Subject:
              </Typography>
              <Typography level="body-md" fontWeight="md">
                {formData.isTestMode ? '[TEST] ' : ''}
                {renderedSubject || 'No subject'}
              </Typography>
            </Box>
          )}

          {/* HTML Preview - fills remaining height */}
          <Box sx={{ flex: 1, p: 2, display: 'flex', flexDirection: 'column', minHeight: 300 }}>
            {previewHtml ? (
              <Sheet
                variant="outlined"
                sx={{
                  borderRadius: 'md',
                  overflow: 'hidden',
                  bgcolor: 'white',
                  flex: 1,
                }}
              >
                <iframe
                  srcDoc={previewHtml}
                  // Opaque-origin, no scripts: rendered email HTML must not run with the
                  // admin's app-origin session.
                  sandbox=""
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                  }}
                  title="Email Preview"
                />
              </Sheet>
            ) : (
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  flex: 1,
                  color: 'neutral.500',
                }}
              >
                <Typography level="body-md">Select a template to see the preview</Typography>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* Bottom Section - Summary and Activity History (only when editing) */}
      {isEditing && jobId && (
        <>
          {/* Summary Row */}
          <Box sx={{ p: 2, bgcolor: 'background.surface', borderBottom: '1px solid', borderColor: 'divider' }}>
            <EmailStatusSummary jobId={jobId} />
          </Box>

          {/* Activity History */}
          <Box sx={{ p: 2 }}>
            <EmailActivityHistory
              jobId={jobId}
              onViewAttempt={attemptId => {
                setSelectedAttempt({ id: attemptId } as EmailAttempt);
                setEmailPreviewModalOpen(true);
              }}
            />
          </Box>
        </>
      )}

      {/* Email Preview Modal */}
      <EmailPreviewModal
        open={emailPreviewModalOpen}
        onClose={() => {
          setEmailPreviewModalOpen(false);
          setSelectedAttempt(null);
        }}
        attemptId={selectedAttempt?.id || null}
      />

      <AdminDialog
        open={viewUsersModalOpen}
        onClose={() => setViewUsersModalOpen(false)}
        title={`Recipients (${recipientPreviewData?.eligibleCount ?? 0} total)`}
        width={600}
        data-testid="email-job-recipients-dialog"
      >
        <Stack gap={2}>
          {recipientPreviewData?.hasMore && (
            <Alert color="neutral" variant="soft">
              Showing first {recipientPreviewData.recipients.length} of {recipientPreviewData.eligibleCount} recipients
              for preview.
            </Alert>
          )}
          <Input
            size="sm"
            placeholder="Search by email or name..."
            value={viewUsersSearch}
            onChange={e => setViewUsersSearch(e.target.value)}
            startDecorator={<SearchIcon />}
          />
          <DataTable
            label="Recipients"
            testId="email-job-recipients-table"
            rows={filteredViewUsersRecipients}
            columns={recipientColumns}
            getRowId={getRecipientId}
            pageResetKey={viewUsersSearch}
            maxHeight="55vh"
            minWidth="16rem"
            onRetry={handlePreviewRecipients}
            empty={renderRecipientsEmpty('email-job-recipients-table')}
          />
        </Stack>
      </AdminDialog>

      <AdminDialog
        open={fullscreenPreviewOpen}
        onClose={() => setFullscreenPreviewOpen(false)}
        title="Email preview"
        width={1200}
        data-testid="email-job-fullscreen-preview-dialog"
      >
        <Stack gap={2}>
          <Select
            size="sm"
            placeholder={
              recipientPreviewData
                ? `Select recipient (${recipientPreviewData.eligibleCount} total)...`
                : 'Loading recipients...'
            }
            disabled={!recipientPreviewData || recipientPreviewData.recipients.length === 0}
            value={selectedPreviewRecipient?.email || ''}
            onChange={(_, value) => {
              const recipient = recipientPreviewData?.recipients.find(r => r.email === value);
              setSelectedPreviewRecipient(recipient || null);
            }}
            sx={{ width: '100%', maxWidth: 420 }}
            data-testid="email-job-preview-recipient-select"
          >
            {recipientPreviewData?.recipients.map(recipient => (
              <Option key={recipient.email} value={recipient.email}>
                {recipient.email}
                {recipient.name ? ` - ${recipient.name}` : ''}
              </Option>
            ))}
            {recipientPreviewData?.hasMore && (
              <Option disabled value="__more__">
                ... and {recipientPreviewData.eligibleCount - recipientPreviewData.recipients.length} more
              </Option>
            )}
          </Select>
          <Box>
            {selectedPreviewRecipient && (
              <Chip size="sm" variant="soft" color="primary" sx={{ mb: 1 }}>
                Previewing as: {selectedPreviewRecipient.name || selectedPreviewRecipient.email}
              </Chip>
            )}
            <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 0.5 }}>
              Subject:
            </Typography>
            <Typography level="body-lg" fontWeight="md">
              {formData.isTestMode ? '[TEST] ' : ''}
              {renderedSubject || 'No subject'}
            </Typography>
          </Box>
          {previewHtml && (
            // Leaves room for the title, select and subject under the dialog's max height, so only the email scrolls.
            <Box
              sx={{
                height: 'calc(100vh - 340px)',
                minHeight: 320,
                bgcolor: 'white',
                borderRadius: 'md',
                overflow: 'hidden',
              }}
            >
              <iframe
                srcDoc={previewHtml}
                // Opaque-origin, no scripts: rendered email HTML must not run with the
                // admin's app-origin session.
                sandbox=""
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="Email Preview Fullscreen"
              />
            </Box>
          )}
        </Stack>
      </AdminDialog>
    </Box>
  );
}
