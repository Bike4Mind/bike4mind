import { useState, useEffect, useRef, useCallback } from 'react';
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
  Tooltip,
  Snackbar,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Divider,
  Alert,
} from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import SendIcon from '@mui/icons-material/Send';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import NewReleasesIcon from '@mui/icons-material/NewReleases';
import {
  useEmailTemplate,
  useCreateEmailTemplate,
  useUpdateEmailTemplate,
} from '@client/app/hooks/data/emailMarketing';
import { EmailCategory } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { APP_NAME } from '@client/config/general'; // brand externalized

const CATEGORY_OPTIONS = [
  { value: EmailCategory.MARKETING, label: 'Marketing' },
  { value: EmailCategory.PRODUCT_UPDATE, label: 'Product Update' },
  { value: EmailCategory.NEWSLETTER, label: 'Newsletter' },
  { value: EmailCategory.ANNOUNCEMENT, label: 'Announcement' },
  { value: EmailCategory.TRANSACTIONAL, label: 'Transactional' },
];

const AVAILABLE_VARIABLES = [
  { variable: '{{userName}}', description: 'Recipient full name' },
  { variable: '{{userFirstName}}', description: 'Recipient first name' },
  { variable: '{{userEmail}}', description: 'Recipient email address' },
  { variable: '{{appName}}', description: 'Application name' },
  { variable: '{{date}}', description: 'Current date' },
  { variable: '{{unsubscribeUrl}}', description: 'Unsubscribe link (required for marketing emails)' },
];

const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

interface TemplateFormData {
  name: string;
  slug: string;
  description: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  category: EmailCategory;
  isActive: boolean;
}

const initialFormData: TemplateFormData = {
  name: '',
  slug: '',
  description: '',
  subject: '',
  htmlContent: '',
  textContent: '',
  category: EmailCategory.MARKETING,
  isActive: true,
};

interface EmailTemplateEditorProps {
  templateId?: string;
  existingSlugs: string[];
  onBack: () => void;
  onSaved: () => void;
}

export default function EmailTemplateEditor({ templateId, existingSlugs, onBack, onSaved }: EmailTemplateEditorProps) {
  const isEditing = !!templateId;
  const { data: existingTemplate, isLoading: isLoadingTemplate } = useEmailTemplate(templateId || '');
  const createMutation = useCreateEmailTemplate();
  const updateMutation = useUpdateEmailTemplate();

  const [formData, setFormData] = useState<TemplateFormData>(initialFormData);
  const [variableGuideExpanded, setVariableGuideExpanded] = useState(true);
  const [whatsNewExpanded, setWhatsNewExpanded] = useState(true);
  const [copiedSnackbar, setCopiedSnackbar] = useState(false);
  const [testEmailOpen, setTestEmailOpen] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [latestModal, setLatestModal] = useState<{
    id: string;
    title: string;
    subtitle?: string;
    createdAt: string;
  } | null>(null);
  const [latestModalHtml, setLatestModalHtml] = useState<string>('');
  const [whatsNewLoading, setWhatsNewLoading] = useState(false);

  // Auto-fetch latest What's New when category is Product Update
  useEffect(() => {
    if (formData.category === EmailCategory.PRODUCT_UPDATE && !latestModal && !whatsNewLoading) {
      // eslint-disable-next-line react-hooks/immutability -- handleFetchLatestWhatsNew is an async conditional fetch called from an effect; React Compiler incorrectly flags async state-setting functions called from effects
      handleFetchLatestWhatsNew();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.category]);

  // Resizable panel state
  const [previewWidth, setPreviewWidth] = useState(50); // percentage
  const isResizing = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseUp = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const newFormWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;
    const newPreviewWidth = 100 - newFormWidth;

    // Clamp between 25% and 75%
    if (newPreviewWidth >= 25 && newPreviewWidth <= 75) {
      setPreviewWidth(newPreviewWidth);
    }
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // Load existing template data
  useEffect(() => {
    if (existingTemplate) {
      setFormData({
        name: existingTemplate.name,
        slug: existingTemplate.slug,
        description: existingTemplate.description || '',
        subject: existingTemplate.subject,
        htmlContent: existingTemplate.htmlContent,
        textContent: existingTemplate.textContent || '',
        category: existingTemplate.category,
        isActive: existingTemplate.isActive,
      });
      setPreviewHtml(existingTemplate.htmlContent);
    }
  }, [existingTemplate]);

  // Generate unique slug
  const generateUniqueSlug = (name: string): string => {
    const baseSlug = generateSlug(name);
    if (!baseSlug) return '';

    // When editing, allow keeping current slug
    if (isEditing && existingTemplate?.slug === baseSlug) {
      return baseSlug;
    }

    const slugsToCheck = existingSlugs.filter(s => s !== existingTemplate?.slug);
    if (!slugsToCheck.includes(baseSlug)) {
      return baseSlug;
    }

    let counter = 1;
    while (slugsToCheck.includes(`${baseSlug}-${String(counter).padStart(2, '0')}`)) {
      counter++;
    }
    return `${baseSlug}-${String(counter).padStart(2, '0')}`;
  };

  const handleNameChange = (name: string) => {
    const newSlug = isEditing ? formData.slug : generateUniqueSlug(name);
    setFormData({ ...formData, name, slug: newSlug });
    setHasUnsavedChanges(true);
  };

  const handleFieldChange = (field: keyof TemplateFormData, value: any) => {
    setFormData({ ...formData, [field]: value });
    setHasUnsavedChanges(true);
  };

  const handleCopyVariable = async (variable: string) => {
    await navigator.clipboard.writeText(variable);
    setCopiedSnackbar(true);
  };

  const handleFetchLatestWhatsNew = async () => {
    setWhatsNewLoading(true);
    try {
      // Fetch just the latest What's New modal (defaults to last 7 days, limit 1)
      const response = await api.get('/api/admin/email/whats-new-content');
      const result = response.data;
      if (result.modals?.length > 0) {
        setLatestModal(result.modals[0]);
        setLatestModalHtml(result.html || '');
      } else {
        setLatestModal(null);
        setLatestModalHtml('');
      }
    } catch (error) {
      console.error("Failed to fetch What's New content:", error);
    } finally {
      setWhatsNewLoading(false);
    }
  };

  const handleCopyWhatsNewHtml = async () => {
    if (latestModalHtml) {
      await navigator.clipboard.writeText(latestModalHtml);
      setCopiedSnackbar(true);
    }
  };

  const updatePreview = () => {
    // Variable replacement for preview
    let html = formData.htmlContent;
    html = html.replace(/{{userName}}/g, 'John Doe');
    html = html.replace(/{{userFirstName}}/g, 'John');
    html = html.replace(/{{userEmail}}/g, 'john@example.com');
    html = html.replace(/{{appName}}/g, APP_NAME || 'App');
    html = html.replace(/{{date}}/g, new Date().toLocaleDateString());
    html = html.replace(/{{unsubscribeUrl}}/g, '#unsubscribe');
    setPreviewHtml(html);
  };

  const handleSave = async () => {
    // Extract variables from content
    const variableRegex = /{{(\w+)}}/g;
    const variables: string[] = [];
    let match;
    const content = formData.htmlContent + ' ' + formData.subject;
    while ((match = variableRegex.exec(content)) !== null) {
      if (!variables.includes(match[1])) {
        variables.push(match[1]);
      }
    }

    try {
      if (isEditing && templateId) {
        await updateMutation.mutateAsync({
          id: templateId,
          ...formData,
          variables,
        });
        setHasUnsavedChanges(false);
        // Stay on page when editing - don't call onSaved()
      } else {
        await createMutation.mutateAsync({
          ...formData,
          variables,
        });
        setHasUnsavedChanges(false);
        onSaved(); // Navigate back only after creating new template
      }
    } catch (error) {
      console.error('Failed to save template:', error);
    }
  };

  const handleSendTest = async () => {
    if (!testEmail || !templateId) return;

    setTestSending(true);
    setTestResult(null);

    try {
      await api.post(`/api/admin/email/templates/${templateId}/test`, {
        email: testEmail,
      });
      setTestResult({ success: true, message: `Test email sent to ${testEmail}` });
      setTestEmail('');
    } catch (error: any) {
      setTestResult({
        success: false,
        message: error.response?.data?.message || 'Failed to send test email',
      });
    } finally {
      setTestSending(false);
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const canSave = formData.name && formData.slug && formData.subject && formData.htmlContent;

  if (isEditing && isLoadingTemplate) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Use same height pattern as AdminSettingsTab: calc(100vh - 200px)
  return (
    <Box sx={{ height: 'calc(100vh - 200px)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.surface',
        }}
      >
        <Button variant="plain" color="neutral" startDecorator={<ArrowBackIcon />} onClick={onBack}>
          Back to Templates
        </Button>

        <Typography level="h4">
          {isEditing ? 'Edit Template' : 'Create Template'}
          {hasUnsavedChanges && (
            <Chip size="sm" color="warning" sx={{ ml: 1 }}>
              Unsaved
            </Chip>
          )}
        </Typography>

        <Stack direction="row" spacing={1}>
          {isEditing && (
            <Button
              variant="outlined"
              color="neutral"
              startDecorator={<SendIcon />}
              onClick={() => setTestEmailOpen(true)}
            >
              Test Email
            </Button>
          )}
          <Button
            variant="solid"
            color="primary"
            startDecorator={<SaveIcon />}
            onClick={handleSave}
            loading={isSaving}
            disabled={!canSave}
          >
            Save
          </Button>
        </Stack>
      </Box>

      {/* Main Content - Two Column Layout with Resizable Divider */}
      <Box ref={containerRef} sx={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {/* Left Column - Form */}
        <Box
          sx={{
            width: `${100 - previewWidth}%`,
            overflow: 'auto',
            p: 3,
            minHeight: 0,
            height: '100%',
          }}
        >
          <Stack spacing={3}>
            {/* Basic Info */}
            <FormControl>
              <FormLabel>Template Name *</FormLabel>
              <Input
                value={formData.name}
                onChange={e => handleNameChange(e.target.value)}
                placeholder="Weekly Newsletter"
              />
              {formData.slug && (
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'neutral.500' }}>
                  Slug: {formData.slug}
                </Typography>
              )}
            </FormControl>

            <FormControl>
              <FormLabel>Description</FormLabel>
              <Input
                value={formData.description}
                onChange={e => handleFieldChange('description', e.target.value)}
                placeholder="Brief description of this template"
              />
            </FormControl>

            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Category *</FormLabel>
                <Select value={formData.category} onChange={(_, value) => handleFieldChange('category', value)}>
                  {CATEGORY_OPTIONS.map(opt => (
                    <Option key={opt.value} value={opt.value}>
                      {opt.label}
                    </Option>
                  ))}
                </Select>
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Status</FormLabel>
                <Select
                  value={formData.isActive ? 'active' : 'inactive'}
                  onChange={(_, value) => handleFieldChange('isActive', value === 'active')}
                >
                  <Option value="active">Active</Option>
                  <Option value="inactive">Inactive</Option>
                </Select>
              </FormControl>
            </Stack>

            <Divider />

            {/* Email Content */}
            <FormControl>
              <FormLabel>Subject Line *</FormLabel>
              <Input
                value={formData.subject}
                onChange={e => handleFieldChange('subject', e.target.value)}
                placeholder="What's New at {{appName}} - {{date}}"
              />
            </FormControl>

            <FormControl>
              <FormLabel>HTML Content *</FormLabel>
              <Textarea
                value={formData.htmlContent}
                onChange={e => handleFieldChange('htmlContent', e.target.value)}
                minRows={15}
                placeholder="<html><body>Your email content here...</body></html>"
                sx={{ fontFamily: 'monospace', fontSize: 'sm' }}
              />
            </FormControl>

            <FormControl>
              <FormLabel>Plain Text Content (Optional)</FormLabel>
              <Textarea
                value={formData.textContent}
                onChange={e => handleFieldChange('textContent', e.target.value)}
                minRows={4}
                placeholder="Plain text version for email clients that don't support HTML..."
              />
            </FormControl>

            {/* Variable Guide */}
            <Accordion
              expanded={variableGuideExpanded}
              onChange={(_, expanded) => setVariableGuideExpanded(expanded ?? false)}
            >
              <AccordionSummary indicator={<ExpandMoreIcon />}>
                <Typography level="title-sm">Available Variables</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography level="body-xs" sx={{ mb: 1.5, color: 'neutral.600' }}>
                  Click on a variable to copy it to your clipboard
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  {AVAILABLE_VARIABLES.map(({ variable, description }) => (
                    <Tooltip key={variable} title={description} placement="top">
                      <Chip
                        variant="soft"
                        color="primary"
                        size="sm"
                        onClick={() => handleCopyVariable(variable)}
                        sx={{
                          cursor: 'pointer',
                          fontFamily: 'monospace',
                          '&:hover': { bgcolor: 'primary.200' },
                        }}
                      >
                        {variable}
                      </Chip>
                    </Tooltip>
                  ))}
                </Box>
              </AccordionDetails>
            </Accordion>

            {/* What's New Content Reference - Only for Product Update templates */}
            {formData.category === EmailCategory.PRODUCT_UPDATE && (
              <Accordion expanded={whatsNewExpanded} onChange={(_, expanded) => setWhatsNewExpanded(expanded ?? false)}>
                <AccordionSummary indicator={<ExpandMoreIcon />}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <NewReleasesIcon sx={{ color: 'primary.500' }} />
                    <Typography level="title-sm">What&apos;s New Content</Typography>
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
                  {whatsNewLoading && (
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }}>
                      <CircularProgress size="sm" />
                      <Typography level="body-sm">Loading latest What&apos;s New...</Typography>
                    </Stack>
                  )}

                  {latestModal && (
                    <Stack spacing={2}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Box>
                          <Typography level="title-sm">{latestModal.title}</Typography>
                          {latestModal.subtitle && (
                            <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                              {latestModal.subtitle}
                            </Typography>
                          )}
                          <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                            {new Date(latestModal.createdAt).toLocaleDateString()}
                          </Typography>
                        </Box>
                        <Button
                          size="sm"
                          variant="solid"
                          color="primary"
                          startDecorator={<ContentCopyIcon />}
                          onClick={handleCopyWhatsNewHtml}
                          disabled={!latestModalHtml}
                        >
                          Copy HTML
                        </Button>
                      </Stack>

                      {/* HTML Preview */}
                      {latestModalHtml && (
                        <Box
                          sx={{
                            maxHeight: 200,
                            overflow: 'auto',
                            bgcolor: 'background.surface',
                            p: 1,
                            borderRadius: 'sm',
                            fontFamily: 'monospace',
                            fontSize: 'xs',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            border: '1px solid',
                            borderColor: 'divider',
                          }}
                        >
                          {latestModalHtml}
                        </Box>
                      )}
                    </Stack>
                  )}

                  {!latestModal && !whatsNewLoading && (
                    <Typography level="body-sm" sx={{ color: 'neutral.500', py: 2 }}>
                      No What&apos;s New modals found. Make sure modals are tagged with &quot;whats-new&quot;.
                    </Typography>
                  )}
                </AccordionDetails>
              </Accordion>
            )}
          </Stack>
        </Box>

        {/* Resizable Divider */}
        <Box
          onMouseDown={handleMouseDown}
          sx={{
            width: 8,
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'background.level2',
            borderLeft: '1px solid',
            borderRight: '1px solid',
            borderColor: 'divider',
            '&:hover': { bgcolor: 'primary.100' },
            transition: 'background-color 0.15s',
          }}
        >
          <DragIndicatorIcon sx={{ fontSize: 16, color: 'neutral.500', transform: 'rotate(90deg)' }} />
        </Box>

        {/* Right Column - Preview */}
        <Box
          sx={{
            width: `${previewWidth}%`,
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'background.level1',
            minHeight: 0,
            height: '100%',
          }}
        >
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              p: 2,
              borderBottom: '1px solid',
              borderColor: 'divider',
              flexShrink: 0,
            }}
          >
            <Typography level="title-md">Template Preview</Typography>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<RefreshIcon />}
              onClick={updatePreview}
            >
              Refresh Preview
            </Button>
          </Box>

          {/* Subject Preview */}
          <Box
            sx={{
              p: 2,
              borderBottom: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.surface',
              flexShrink: 0,
            }}
          >
            <Typography level="body-xs" sx={{ color: 'neutral.500', mb: 0.5 }}>
              Subject:
            </Typography>
            <Typography level="body-md" fontWeight="md">
              {formData.subject
                .replace(/{{userName}}/g, 'John Doe')
                .replace(/{{userFirstName}}/g, 'John')
                .replace(/{{userEmail}}/g, 'john@example.com')
                .replace(/{{appName}}/g, APP_NAME || 'App')
                .replace(/{{date}}/g, new Date().toLocaleDateString()) || 'No subject'}
            </Typography>
          </Box>

          {/* HTML Preview */}
          <Box sx={{ flex: 1, overflow: 'auto', p: 2, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {previewHtml ? (
              <Sheet
                variant="outlined"
                sx={{
                  borderRadius: 'md',
                  overflow: 'hidden',
                  bgcolor: 'white',
                  flex: 1,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <iframe
                  srcDoc={previewHtml}
                  style={{
                    width: '100%',
                    height: '100%',
                    flex: 1,
                    minHeight: 0,
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
                <Typography level="body-md">
                  Enter HTML content and click &quot;Refresh Preview&quot; to see the preview
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* Test Email Dialog */}
      {testEmailOpen && (
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            bgcolor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
          onClick={() => setTestEmailOpen(false)}
        >
          <Sheet variant="outlined" sx={{ p: 3, borderRadius: 'md', width: 400 }} onClick={e => e.stopPropagation()}>
            <Typography level="h4" sx={{ mb: 2 }}>
              Send Test Email
            </Typography>

            {testResult && (
              <Alert color={testResult.success ? 'success' : 'danger'} sx={{ mb: 2 }}>
                {testResult.message}
              </Alert>
            )}

            <FormControl sx={{ mb: 2 }}>
              <FormLabel>Recipient Email</FormLabel>
              <Input
                type="email"
                value={testEmail}
                onChange={e => setTestEmail(e.target.value)}
                placeholder="test@example.com"
              />
            </FormControl>

            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button variant="plain" color="neutral" onClick={() => setTestEmailOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="solid"
                color="primary"
                onClick={handleSendTest}
                loading={testSending}
                disabled={!testEmail}
              >
                Send Test
              </Button>
            </Stack>
          </Sheet>
        </Box>
      )}

      {/* Copy Snackbar */}
      <Snackbar
        open={copiedSnackbar}
        autoHideDuration={2000}
        onClose={() => setCopiedSnackbar(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        Variable copied to clipboard
      </Snackbar>
    </Box>
  );
}
