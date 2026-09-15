import React, { useState, useEffect, useRef } from 'react';
import {
  FormControl,
  FormLabel,
  Select,
  Option,
  Button,
  Typography,
  Box,
  Stack,
  FormHelperText,
  Alert,
  CircularProgress,
  Input,
  Divider,
  Textarea,
  List,
  ListItem,
  Modal,
  ModalDialog,
  ModalClose,
  Sheet,
  Chip,
  IconButton,
  Tooltip,
} from '@mui/joy';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import SaveIcon from '@mui/icons-material/Save';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import VisibilityIcon from '@mui/icons-material/Visibility';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CodeIcon from '@mui/icons-material/Code';
import { toast } from 'sonner';
import { WhatsNewConfig, WHATS_NEW_VALIDATION_LIMITS } from '@bike4mind/common';
import {
  getDefaultTemplateString,
  TEMPLATE_VARIABLE_DOCS,
} from '@client/server/queueHandlers/whatsNewGeneration.templateConstants';

interface WhatsNewConfigResponse {
  success: boolean;
  config: WhatsNewConfig;
}

export const AdminWhatsNewConfiguration: React.FC = () => {
  const { data: models } = useModelInfo();
  const queryClient = useQueryClient();
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [defaultTemplateOpen, setDefaultTemplateOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    data: currentConfig,
    isLoading: configLoading,
    error,
  } = useQuery({
    queryKey: ['whatsNewConfig'],
    queryFn: async () => {
      const response = await api.get('/api/admin/whats-new-config');
      return response.data as WhatsNewConfig;
    },
  });

  const [config, setConfig] = useState<WhatsNewConfig>({
    modelId: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 2000,
    timeoutMs: 120000,
    modalPriority: 10,
    modalExpiryDays: 30,
    maxPreviousModals: 10,
    titleMaxLength: 100,
    subtitleMaxLength: 200,
    descriptionMaxLength: 2000,
    maxCommits: 50,
    maxPullRequests: 20,
    maxReleaseBodyLength: 2000,
    maxCommitMessageLength: 200,
    maxPRBodyLength: 500,
    maxChangelogLength: 1000,
    repository: 'MillionOnMars/lumina5',
    targetBranch: 'prod',
  });

  useEffect(() => {
    if (currentConfig) {
      setConfig(currentConfig);
    }
  }, [currentConfig]);

  const updateMutation = useMutation({
    mutationFn: async (newConfig: WhatsNewConfig) => {
      const response = await api.put('/api/admin/whats-new-config', newConfig);
      return response.data as WhatsNewConfigResponse;
    },
    onSuccess: () => {
      toast.success("What's New configuration updated successfully");
      setValidationErrors([]);
      queryClient.invalidateQueries({ queryKey: ['whatsNewConfig'] });
    },
    onError: (error: any) => {
      console.error('Update configuration error:', error);
      console.error('Error response:', error.response);
      console.error('Error response data:', error.response?.data);

      // Check if it's a template validation error
      const validationErrs = error.response?.data?.validationErrors || error.response?.data?.details;

      if (validationErrs && Array.isArray(validationErrs)) {
        setValidationErrors(validationErrs);
        toast.error('Invalid prompt template. Please fix the errors below.');
      } else if (error.response?.data?.error) {
        toast.error(`Failed to update configuration: ${error.response.data.error}`);
      } else {
        toast.error(`Failed to update configuration: ${error.message}`);
      }
    },
  });

  const previewMutation = useMutation({
    mutationFn: async (template?: string) => {
      const response = await api.post('/api/admin/whats-new-config/preview', {
        template,
      });
      return response.data;
    },
    onSuccess: data => {
      setPreviewContent(data.preview);
      setPreviewOpen(true);
    },
    onError: (error: any) => {
      const errorMsg = error.response?.data?.details || error.message;
      toast.error(`Preview generation failed: ${errorMsg}`);
    },
  });

  const textModels = models?.filter(m => m.type === 'text') || [];
  const currentModelInfo = textModels.find(m => m.id === config.modelId);

  // Group text models by provider
  const modelsByProvider = textModels.reduce(
    (acc, model) => {
      const provider = model.backend || 'unknown';
      if (!acc[provider]) acc[provider] = [];
      acc[provider].push(model);
      return acc;
    },
    {} as Record<string, typeof textModels>
  );

  const isDirty = JSON.stringify(config) !== JSON.stringify(currentConfig);

  const formatRange = (limits: { min: number; max: number }) =>
    `Range: ${limits.min.toLocaleString()}-${limits.max.toLocaleString()}`;

  const handleSave = () => {
    updateMutation.mutate(config);
  };

  const handleReset = () => {
    if (currentConfig) {
      setConfig(currentConfig);
    }
  };

  const handlePreview = () => {
    previewMutation.mutate(config.promptTemplate);
  };

  const handleCopyVariable = (variable: string) => {
    navigator.clipboard.writeText(`{{${variable}}}`);
    toast.success(`Copied {{${variable}}} to clipboard`);
  };

  const handleInsertVariable = (variable: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = config.promptTemplate || '';
    const variableText = `{{${variable}}}`;
    const newValue = currentValue.substring(0, start) + variableText + currentValue.substring(end);

    setConfig({ ...config, promptTemplate: newValue });

    // Set cursor position after inserted variable
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + variableText.length, start + variableText.length);
    }, 0);

    toast.success(`Inserted {{${variable}}}`);
  };

  const handleViewDefaultTemplate = () => {
    setDefaultTemplateOpen(true);
  };

  if (configLoading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <CircularProgress size="sm" />
        <Typography>Loading configuration...</Typography>
      </Box>
    );
  }

  if (error) {
    console.error(error);
    return (
      <Alert color="danger" startDecorator={<ErrorIcon />}>
        Failed to load What&apos;s New configuration
      </Alert>
    );
  }

  return (
    <Stack spacing={3}>
      {/* GitHub Repository Section */}
      <Typography level="title-sm">GitHub Repository</Typography>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        <FormControl error={!!config.repository && !/^[\w.-]+\/[\w.-]+$/.test(config.repository)}>
          <FormLabel>Repository</FormLabel>
          <Input
            value={config.repository || 'MillionOnMars/lumina5'}
            onChange={e => setConfig({ ...config, repository: e.target.value })}
            placeholder="e.g., YourOrg/your-repo"
            data-testid="whats-new-repository-input"
          />
          <FormHelperText>
            {config.repository && !/^[\w.-]+\/[\w.-]+$/.test(config.repository)
              ? 'Must be in owner/repo format (e.g., MyOrg/my-repo)'
              : 'GitHub owner/repo to collect PRs from'}
          </FormHelperText>
        </FormControl>
        <FormControl error={!!config.targetBranch && !/^[\w./-]+$/.test(config.targetBranch)}>
          <FormLabel>Target Branch</FormLabel>
          <Input
            value={config.targetBranch || 'prod'}
            onChange={e => setConfig({ ...config, targetBranch: e.target.value })}
            placeholder="e.g., prod, main"
            data-testid="whats-new-target-branch-input"
          />
          <FormHelperText>
            {config.targetBranch && !/^[\w./-]+$/.test(config.targetBranch)
              ? 'Must be a valid branch name'
              : 'Branch to filter merged PRs by base'}
          </FormHelperText>
        </FormControl>
      </Box>

      {/* Model Configuration Section */}
      <Typography level="title-sm">Model Configuration</Typography>

      <FormControl sx={{ mb: 2 }}>
        <FormLabel>LLM Model</FormLabel>
        <Select
          value={config.modelId}
          onChange={(_, value) => {
            if (value && !value.startsWith('__header_')) {
              setConfig({ ...config, modelId: value });
            }
          }}
          placeholder="Choose a model..."
        >
          {Object.entries(modelsByProvider)
            .map(([provider, providerModels]) => [
              <Option key={`${provider}-header`} value={`__header_${provider}`} disabled>
                <Typography
                  level="body-xs"
                  sx={{ fontWeight: 'bold', textTransform: 'uppercase', color: 'text.primary50' }}
                >
                  {provider}
                </Typography>
              </Option>,
              ...providerModels.map(model => (
                <Option key={model.id} value={model.id}>
                  <Typography sx={{ color: 'text.primary' }}>{model.name}</Typography>
                </Option>
              )),
            ])
            .flat()}
        </Select>
        <FormHelperText>Model used for generating modal content from release information</FormHelperText>
      </FormControl>

      {currentModelInfo && (
        <Alert sx={{ mb: 2 }} size="sm" startDecorator={<CheckCircleIcon />}>
          <Typography level="body-sm">
            <strong>{currentModelInfo.name}</strong> ({currentModelInfo.backend}) •{' '}
            {(currentModelInfo.contextWindow / 1000).toFixed(0)}K context
          </Typography>
        </Alert>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
        <FormControl>
          <FormLabel>Temperature</FormLabel>
          <Input
            type="number"
            value={config.temperature}
            onChange={e => setConfig({ ...config, temperature: parseFloat(e.target.value) })}
            slotProps={{ input: { ...WHATS_NEW_VALIDATION_LIMITS.temperature, step: 0.1 } }}
          />
          <FormHelperText>
            Higher = more creative. {formatRange(WHATS_NEW_VALIDATION_LIMITS.temperature)}
          </FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Max Tokens</FormLabel>
          <Input
            type="number"
            value={config.maxTokens}
            onChange={e => setConfig({ ...config, maxTokens: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.maxTokens }}
          />
          <FormHelperText>Maximum response length. {formatRange(WHATS_NEW_VALIDATION_LIMITS.maxTokens)}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Timeout (ms)</FormLabel>
          <Input
            type="number"
            value={config.timeoutMs}
            onChange={e => setConfig({ ...config, timeoutMs: parseInt(e.target.value) })}
            slotProps={{ input: { ...WHATS_NEW_VALIDATION_LIMITS.timeoutMs, step: 1000 } }}
          />
          <FormHelperText>LLM request timeout. {formatRange(WHATS_NEW_VALIDATION_LIMITS.timeoutMs)}</FormHelperText>
        </FormControl>
      </Box>

      <Divider />

      {/* Modal Configuration Section */}
      <Typography level="title-sm">Modal Settings</Typography>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
        <FormControl>
          <FormLabel>Priority</FormLabel>
          <Input
            type="number"
            value={config.modalPriority}
            onChange={e => setConfig({ ...config, modalPriority: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.modalPriority }}
          />
          <FormHelperText>Display priority. {formatRange(WHATS_NEW_VALIDATION_LIMITS.modalPriority)}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Expiry (days)</FormLabel>
          <Input
            type="number"
            value={config.modalExpiryDays}
            onChange={e => setConfig({ ...config, modalExpiryDays: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.modalExpiryDays }}
          />
          <FormHelperText>
            Days until modal expires. {formatRange(WHATS_NEW_VALIDATION_LIMITS.modalExpiryDays)}
          </FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Style Examples</FormLabel>
          <Input
            type="number"
            value={config.maxPreviousModals}
            onChange={e => setConfig({ ...config, maxPreviousModals: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.maxPreviousModals }}
          />
          <FormHelperText>
            Previous modals for learning. {formatRange(WHATS_NEW_VALIDATION_LIMITS.maxPreviousModals)}
          </FormHelperText>
        </FormControl>
      </Box>

      <Divider />

      {/* Validation Limits Section */}
      <Typography level="title-sm">Validation Limits</Typography>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
        <FormControl>
          <FormLabel>Title Max Length</FormLabel>
          <Input
            type="number"
            value={config.titleMaxLength}
            onChange={e => setConfig({ ...config, titleMaxLength: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.titleMaxLength }}
          />
          <FormHelperText>{formatRange(WHATS_NEW_VALIDATION_LIMITS.titleMaxLength)}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Subtitle Max Length</FormLabel>
          <Input
            type="number"
            value={config.subtitleMaxLength}
            onChange={e => setConfig({ ...config, subtitleMaxLength: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.subtitleMaxLength }}
          />
          <FormHelperText>{formatRange(WHATS_NEW_VALIDATION_LIMITS.subtitleMaxLength)}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Description Max Length</FormLabel>
          <Input
            type="number"
            value={config.descriptionMaxLength}
            onChange={e => setConfig({ ...config, descriptionMaxLength: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.descriptionMaxLength }}
          />
          <FormHelperText>{formatRange(WHATS_NEW_VALIDATION_LIMITS.descriptionMaxLength)}</FormHelperText>
        </FormControl>
      </Box>

      <Divider />

      {/* Sanitization Limits Section */}
      <Typography level="title-sm">Content Sanitization Limits</Typography>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
        <FormControl>
          <FormLabel>Max Commits</FormLabel>
          <Input
            type="number"
            value={config.maxCommits}
            onChange={e => setConfig({ ...config, maxCommits: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.maxCommits }}
          />
          <FormHelperText>Per release. {formatRange(WHATS_NEW_VALIDATION_LIMITS.maxCommits)}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Max Pull Requests</FormLabel>
          <Input
            type="number"
            value={config.maxPullRequests}
            onChange={e => setConfig({ ...config, maxPullRequests: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.maxPullRequests }}
          />
          <FormHelperText>Per release. {formatRange(WHATS_NEW_VALIDATION_LIMITS.maxPullRequests)}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Commit Message Length</FormLabel>
          <Input
            type="number"
            value={config.maxCommitMessageLength}
            onChange={e => setConfig({ ...config, maxCommitMessageLength: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.maxCommitMessageLength }}
          />
          <FormHelperText>{formatRange(WHATS_NEW_VALIDATION_LIMITS.maxCommitMessageLength)}</FormHelperText>
        </FormControl>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
        <FormControl>
          <FormLabel>Release Body Length</FormLabel>
          <Input
            type="number"
            value={config.maxReleaseBodyLength}
            onChange={e => setConfig({ ...config, maxReleaseBodyLength: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.maxReleaseBodyLength }}
          />
          <FormHelperText>{formatRange(WHATS_NEW_VALIDATION_LIMITS.maxReleaseBodyLength)}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>PR Body Length</FormLabel>
          <Input
            type="number"
            value={config.maxPRBodyLength}
            onChange={e => setConfig({ ...config, maxPRBodyLength: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.maxPRBodyLength }}
          />
          <FormHelperText>{formatRange(WHATS_NEW_VALIDATION_LIMITS.maxPRBodyLength)}</FormHelperText>
        </FormControl>

        <FormControl>
          <FormLabel>Changelog Length</FormLabel>
          <Input
            type="number"
            value={config.maxChangelogLength}
            onChange={e => setConfig({ ...config, maxChangelogLength: parseInt(e.target.value) })}
            slotProps={{ input: WHATS_NEW_VALIDATION_LIMITS.maxChangelogLength }}
          />
          <FormHelperText>{formatRange(WHATS_NEW_VALIDATION_LIMITS.maxChangelogLength)}</FormHelperText>
        </FormControl>
      </Box>

      <Divider />

      {/* Prompt Template Section */}
      <Typography level="title-sm">Custom Prompt Template (Optional)</Typography>

      <Box>
        <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1 }}>
          Available variables:
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {(Object.keys(TEMPLATE_VARIABLE_DOCS) as Array<keyof typeof TEMPLATE_VARIABLE_DOCS>).map(variable => (
            <Tooltip key={variable} title={TEMPLATE_VARIABLE_DOCS[variable]}>
              <Chip
                size="sm"
                variant="outlined"
                onClick={() => handleInsertVariable(variable)}
                sx={{ fontFamily: 'monospace', cursor: 'pointer' }}
                data-testid={`variable-chip-${variable}`}
                endDecorator={
                  <IconButton
                    size="sm"
                    variant="plain"
                    onClick={e => {
                      e.stopPropagation();
                      handleCopyVariable(variable);
                    }}
                  >
                    <ContentCopyIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                }
              >
                {`{{${variable}}}`}
              </Chip>
            </Tooltip>
          ))}
        </Box>
      </Box>

      <FormControl sx={{ mb: 1 }}>
        <FormLabel>Prompt Template</FormLabel>
        <Textarea
          minRows={12}
          maxRows={24}
          value={config.promptTemplate || ''}
          onChange={e => {
            setConfig({ ...config, promptTemplate: e.target.value || undefined });
            if (validationErrors.length > 0) setValidationErrors([]);
          }}
          placeholder="Leave empty to use default template, or enter custom Handlebars template..."
          sx={{ fontFamily: 'monospace', fontSize: 'sm' }}
          color={validationErrors.length > 0 ? 'danger' : undefined}
          data-testid="prompt-template-textarea"
          slotProps={{
            textarea: {
              ref: textareaRef,
            },
          }}
        />
        <FormHelperText>
          Custom template for generating What&apos;s New content. Uses Handlebars syntax. Leave empty to use the default
          template.
        </FormHelperText>
      </FormControl>

      {validationErrors.length > 0 && (
        <Alert color="danger" sx={{ mb: 2 }} startDecorator={<ErrorIcon />}>
          <Typography level="title-sm">Template Validation Errors:</Typography>
          <List size="sm">
            {validationErrors.map((error, index) => (
              <ListItem key={index}>{error}</ListItem>
            ))}
          </List>
        </Alert>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography
          level="body-sm"
          color={config.promptTemplate && config.promptTemplate.length > 9500 ? 'danger' : 'neutral'}
        >
          {config.promptTemplate?.length || 0} / 10,000 characters
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={handleViewDefaultTemplate}
            startDecorator={<CodeIcon />}
            data-testid="view-default-template-btn"
          >
            View Default Template
          </Button>
          <Button
            size="sm"
            variant="outlined"
            color="primary"
            onClick={handlePreview}
            loading={previewMutation.isPending}
            startDecorator={<VisibilityIcon />}
            data-testid="preview-template-btn"
          >
            Preview LLM Prompt
          </Button>
          {config.promptTemplate && (
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => setConfig({ ...config, promptTemplate: undefined })}
              data-testid="clear-template-btn"
            >
              Clear Template (Use Default)
            </Button>
          )}
        </Box>
      </Box>

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
        {isDirty && (
          <Chip color="warning" variant="outlined" size="sm">
            Unsaved changes
          </Chip>
        )}
        <Button variant="outlined" color="neutral" size="sm" disabled={!isDirty} onClick={handleReset}>
          Reset
        </Button>
        <Button
          variant="solid"
          color="primary"
          size="sm"
          disabled={!isDirty}
          loading={updateMutation.isPending}
          onClick={handleSave}
          startDecorator={<SaveIcon />}
        >
          Save
        </Button>
      </Box>

      <Typography level="body-xs" sx={{ mt: 1, color: 'text.secondary' }}>
        <strong>Note:</strong> Changes take effect immediately for new modal generation requests. Existing queue
        messages will use the configuration active at the time they were created.
      </Typography>

      {/* Preview LLM Prompt Modal */}
      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)}>
        <ModalDialog
          sx={{
            maxWidth: '90vw',
            width: 900,
            maxHeight: '90vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ModalClose />
          <Typography level="h4" sx={{ mb: 1 }}>
            LLM Prompt Preview
          </Typography>
          <Alert variant="soft" color="primary" sx={{ mb: 2 }}>
            <Typography level="body-sm">
              This shows the <strong>input prompt</strong> that will be sent to the LLM, not the final modal output.
              Sample data is used for demonstration.
            </Typography>
          </Alert>
          <Divider sx={{ mb: 2 }} />
          <Sheet
            sx={{
              flex: 1,
              overflow: 'auto',
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: 'sm',
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Typography
              component="pre"
              sx={{
                fontFamily: 'monospace',
                fontSize: 'xs',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                m: 0,
              }}
            >
              {previewContent}
            </Typography>
          </Sheet>
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setPreviewOpen(false)}>Close</Button>
          </Box>
        </ModalDialog>
      </Modal>

      {/* Default Template Modal */}
      <Modal open={defaultTemplateOpen} onClose={() => setDefaultTemplateOpen(false)}>
        <ModalDialog
          sx={{
            maxWidth: '90vw',
            width: 900,
            maxHeight: '90vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ModalClose />
          <Typography level="h4" sx={{ mb: 1 }}>
            Default Prompt Template
          </Typography>
          <Alert variant="soft" color="neutral" sx={{ mb: 2 }}>
            <Typography level="body-sm">
              This is the default template used when no custom template is specified. You can use this as a reference or
              starting point for your custom template.
            </Typography>
          </Alert>
          <Divider sx={{ mb: 2 }} />
          <Sheet
            sx={{
              flex: 1,
              overflow: 'auto',
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: 'sm',
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Typography
              component="pre"
              sx={{
                fontFamily: 'monospace',
                fontSize: 'xs',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                m: 0,
              }}
            >
              {getDefaultTemplateString()}
            </Typography>
          </Sheet>
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between', gap: 1 }}>
            <Button
              variant="outlined"
              startDecorator={<ContentCopyIcon />}
              onClick={() => {
                navigator.clipboard.writeText(getDefaultTemplateString());
                toast.success('Default template copied to clipboard');
              }}
              data-testid="copy-default-template-btn"
            >
              Copy Template
            </Button>
            <Button onClick={() => setDefaultTemplateOpen(false)}>Close</Button>
          </Box>
        </ModalDialog>
      </Modal>
    </Stack>
  );
};
