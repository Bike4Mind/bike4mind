import React, { useState, useMemo, useEffect } from 'react';
import {
  Typography,
  Stack,
  Button,
  FormControl,
  FormLabel,
  Input,
  Textarea,
  Box,
  Alert,
  Switch,
  Divider,
} from '@mui/joy';
import { AdminDialog, AdminDialogFooter } from '@client/app/components/admin/shared/AdminDialog';
import Info from '@mui/icons-material/Info';
import { useBrandingSettings } from '@client/app/hooks/data/settings';
import { api } from '@client/app/contexts/ApiContext';
import { generateFullManifest } from '@bike4mind/common';
import { APP_NAME } from '@client/config/general';

// Brand-derived Slack app defaults. APP_NAME is empty when unconfigured, so fall
// back to a generic "Bot"/"AI bot" label rather than a hardcoded brand.
const defaultBotName = APP_NAME ? `${APP_NAME} Bot` : 'Bot';
const defaultBotDescription = APP_NAME ? `${APP_NAME} AI bot` : 'AI bot';

interface CreateSlackAppModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

interface ManifestFormData {
  name: string;
  description: string;
  backgroundColor: string;
  baseUrl: string;
  configToken: string;
  enableWorkflowSteps: boolean;
}

export default function CreateSlackAppModal({ open, onClose, onSuccess }: CreateSlackAppModalProps) {
  const { data: brandingSettings } = useBrandingSettings();

  const currentUrl = typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '';

  const defaultName = brandingSettings?.tagLineMain || defaultBotName;

  const [formData, setFormData] = useState<ManifestFormData>({
    name: defaultName,
    description: defaultBotDescription,
    backgroundColor: '#2c2d30',
    baseUrl: currentUrl,
    configToken: '',
    enableWorkflowSteps: true,
  });

  // Update form data when branding settings load
  useEffect(() => {
    if (brandingSettings?.tagLineMain) {
      setFormData(prev => ({
        ...prev,
        name: brandingSettings.tagLineMain,
      }));
    }
  }, [brandingSettings]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showWorkflowWarning, setShowWorkflowWarning] = useState(false);

  // Generate manifest based on form data using shared template
  const manifest = useMemo(() => {
    return generateFullManifest({
      name: formData.name,
      description: formData.description,
      backgroundColor: formData.backgroundColor,
      baseUrl: formData.baseUrl,
      enableWorkflowSteps: formData.enableWorkflowSteps,
    });
  }, [formData]);

  const handleWorkflowStepsToggle = (checked: boolean) => {
    if (!checked) {
      // Toggling off requires confirmation
      setShowWorkflowWarning(true);
    } else {
      setFormData(prev => ({ ...prev, enableWorkflowSteps: true }));
    }
  };

  const confirmDisableWorkflowSteps = () => {
    setFormData(prev => ({ ...prev, enableWorkflowSteps: false }));
    setShowWorkflowWarning(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    if (!formData.configToken.trim()) {
      setError('Config token is required');
      setLoading(false);
      return;
    }

    try {
      await api.post('/api/admin/slack-app/create', {
        manifest,
        configToken: formData.configToken,
        enableWorkflowSteps: formData.enableWorkflowSteps,
      });

      setSuccess(true);
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setError(null);
      setSuccess(false);
      onClose();
    }
  };

  return (
    <>
      <AdminDialog
        open={open}
        onClose={handleClose}
        closeDisabled={loading}
        title="Create Slack app from manifest"
        width={1000}
        data-testid="create-slack-app-modal"
      >
        <form onSubmit={handleSubmit}>
          <Stack spacing={3}>
            <Alert color="primary" startDecorator={<Info />}>
              This will create a new Slack app using the manifest below. Make sure to configure the values correctly
              before submitting.
            </Alert>

            {error && (
              <Alert color="danger">
                <Typography level="body-sm">{error}</Typography>
              </Alert>
            )}

            {success && (
              <Alert color="success">
                <Typography level="body-sm">Slack app created successfully!</Typography>
              </Alert>
            )}

            <Stack direction="row" spacing={2}>
              {/* Form Column */}
              <Box sx={{ flex: 1 }}>
                <Typography level="title-md" sx={{ mb: 2 }}>
                  App Configuration
                </Typography>

                <Stack spacing={2}>
                  <FormControl required>
                    <FormLabel>App Name</FormLabel>
                    <Input
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      placeholder={defaultBotName}
                      disabled={loading}
                    />
                  </FormControl>

                  <FormControl required>
                    <FormLabel>Description</FormLabel>
                    <Input
                      value={formData.description}
                      onChange={e => setFormData({ ...formData, description: e.target.value })}
                      placeholder={defaultBotDescription}
                      disabled={loading}
                    />
                  </FormControl>

                  <FormControl required>
                    <FormLabel>Background Color</FormLabel>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Input
                        type="color"
                        value={formData.backgroundColor}
                        onChange={e =>
                          setFormData({
                            ...formData,
                            backgroundColor: e.target.value,
                          })
                        }
                        sx={{ width: 60, height: 40 }}
                        disabled={loading}
                      />
                      <Input
                        value={formData.backgroundColor}
                        onChange={e =>
                          setFormData({
                            ...formData,
                            backgroundColor: e.target.value,
                          })
                        }
                        placeholder="#2c2d30"
                        disabled={loading}
                        sx={{ flex: 1 }}
                      />
                    </Stack>
                  </FormControl>

                  <FormControl required>
                    <FormLabel>Base URL</FormLabel>
                    <Input
                      value={formData.baseUrl}
                      onChange={e => setFormData({ ...formData, baseUrl: e.target.value })}
                      placeholder={currentUrl}
                      disabled={loading}
                    />
                  </FormControl>

                  <FormControl required>
                    <FormLabel>Slack Config Token</FormLabel>
                    <Input
                      type="password"
                      value={formData.configToken}
                      slotProps={{ input: { 'data-testid': 'create-slack-app-token-input' } }}
                      onChange={e => setFormData({ ...formData, configToken: e.target.value })}
                      placeholder="xoxp-..."
                      disabled={loading}
                    />
                    <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.secondary' }}>
                      Go to{' '}
                      <a
                        href="https://api.slack.com/apps"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'inherit', textDecoration: 'underline' }}
                      >
                        api.slack.com/apps
                      </a>
                      , scroll below the app list, and click Generate Token under Your App Configuration Tokens.
                    </Typography>
                  </FormControl>

                  <Divider sx={{ my: 1 }} />

                  <FormControl
                    orientation="horizontal"
                    sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <Box>
                      <FormLabel>Workflow Steps</FormLabel>
                      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                        Enable custom Slack Workflow functions (requires a paid Slack plan)
                      </Typography>
                    </Box>
                    <Switch
                      data-testid="workflow-steps-toggle"
                      checked={formData.enableWorkflowSteps}
                      onChange={e => handleWorkflowStepsToggle(e.target.checked)}
                      disabled={loading}
                    />
                  </FormControl>
                </Stack>
              </Box>

              {/* Manifest Preview Column */}
              <Box sx={{ flex: 1 }}>
                <Typography level="title-md" sx={{ mb: 2 }}>
                  Manifest Preview
                </Typography>

                <Textarea
                  value={JSON.stringify(manifest, null, 2)}
                  readOnly
                  minRows={20}
                  maxRows={20}
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    '& textarea': {
                      cursor: 'default',
                    },
                  }}
                />
              </Box>
            </Stack>

            <AdminDialogFooter>
              <Button
                variant="plain"
                color="neutral"
                onClick={handleClose}
                disabled={loading}
                data-testid="create-slack-app-cancel-btn"
              >
                Cancel
              </Button>
              <Button type="submit" loading={loading} disabled={success} data-testid="create-slack-app-submit-btn">
                Create Slack App
              </Button>
            </AdminDialogFooter>
          </Stack>
        </form>
      </AdminDialog>

      {/* Confirmation dialog for disabling Workflow Steps */}
      <AdminDialog
        open={showWorkflowWarning}
        onClose={() => setShowWorkflowWarning(false)}
        title="Disable workflow steps?"
        role="alertdialog"
        width={520}
        data-testid="workflow-steps-warning-modal"
      >
        <Stack spacing={2}>
          <Typography level="body-md">
            Disabling Workflow Steps will remove the following from the Slack manifest:
          </Typography>
          <Alert color="warning" variant="soft">
            <Stack spacing={1}>
              <Typography level="body-sm">
                <strong>Custom functions removed:</strong>
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2 }}>
                <Typography level="body-sm" component="li">
                  Create Notebook (b4m_create_notebook)
                </Typography>
                <Typography level="body-sm" component="li">
                  Send to B4M (b4m_send_message)
                </Typography>
                <Typography level="body-sm" component="li">
                  Query B4M (b4m_query)
                </Typography>
              </Box>
              <Typography level="body-sm" sx={{ mt: 1 }}>
                <strong>Settings changes:</strong>
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2 }}>
                <Typography level="body-sm" component="li">
                  function_executed event removed
                </Typography>
                <Typography level="body-sm" component="li">
                  function_runtime setting removed
                </Typography>
                <Typography level="body-sm" component="li">
                  org_deploy_enabled set to false
                </Typography>
              </Box>
            </Stack>
          </Alert>
          <Typography level="body-sm">
            These features require a paid Slack plan. You can re-enable them at any time.
          </Typography>
        </Stack>
        <AdminDialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => setShowWorkflowWarning(false)}
            data-testid="workflow-steps-cancel-disable"
          >
            Cancel
          </Button>
          <Button
            variant="solid"
            color="warning"
            onClick={confirmDisableWorkflowSteps}
            data-testid="workflow-steps-confirm-disable"
          >
            Disable Workflow Steps
          </Button>
        </AdminDialogFooter>
      </AdminDialog>
    </>
  );
}
