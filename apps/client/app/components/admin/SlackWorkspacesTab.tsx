import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Table,
  Typography,
  CircularProgress,
  DialogTitle,
  DialogContent,
  DialogActions,
  Checkbox,
  LinearProgress,
  Switch,
  Divider,
  Tooltip,
} from '@mui/joy';
import {
  Refresh,
  Delete,
  Warning,
  Add,
  Download,
  Cancel,
  CheckCircle,
  Error,
  InfoOutlined,
  Update,
  LinkOff,
} from '@mui/icons-material';
import Image from 'next/image';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import CreateSlackAppModal from './CreateSlackAppModal';
import { SlackEvents } from '@bike4mind/common';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

interface SlackWorkspace {
  id: string;
  name: string;
  slackTeamId?: string;
  slackBotName?: string;
  slackBotUserId?: string;
  slackAppId: string;
  isActive: boolean;
  installedAt?: string;
  updatedAt: string;
}

import { ManifestDifference } from '@bike4mind/common';

type ManifestStatus =
  | { status: 'checking' }
  | { status: 'up_to_date' }
  | { status: 'outdated'; differences: ManifestDifference[] }
  | { status: 'missing_token'; message: string }
  | { status: 'error'; message: string };

function extractErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) return error.response?.data?.error || error.response?.data?.message || error.message;
  // isAxiosError's type predicate narrows false branch to {}, use assertion after instanceof
  if (error instanceof Error) return (error as Error).message;
  return fallback;
}

interface AsyncExportJob {
  id: string;
  channelId: string;
  channelName?: string;
  format: 'json' | 'csv' | 'markdown';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  currentStep: string;
  processedMessages?: number;
  totalMessages?: number;
  createdAt: string;
  completedAt?: string;
  downloadUrl?: string;
  downloadExpiresAt?: string;
  fileSize?: number;
  errorMessage?: string;
}

const SlackWorkspacesTab: React.FC = () => {
  const isMobile = useIsMobile();
  const { mutate: logEvent } = useLogEvent();
  const [workspaces, setWorkspaces] = useState<SlackWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<SlackWorkspace | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [createAppModalOpen, setCreateAppModalOpen] = useState(false);

  // Manifest status state
  const [manifestStatuses, setManifestStatuses] = useState<Record<string, ManifestStatus>>({});
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateModalWorkspace, setUpdateModalWorkspace] = useState<SlackWorkspace | null>(null);
  const [updating, setUpdating] = useState(false);
  const [reconnectModalOpen, setReconnectModalOpen] = useState(false);
  const [reconnectModalWorkspace, setReconnectModalWorkspace] = useState<SlackWorkspace | null>(null);
  const [reconnectToken, setReconnectToken] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  const checkManifestStatuses = useCallback(async (ws: SlackWorkspace[]) => {
    const initial: Record<string, ManifestStatus> = {};
    for (const w of ws) {
      initial[w.id] = { status: 'checking' };
    }
    setManifestStatuses(initial);

    const results = await Promise.allSettled(
      ws.map(async w => {
        const response = await api.get(`/api/admin/slack-app/manifest-status?workspaceId=${w.id}`);
        return { id: w.id, data: response.data };
      })
    );

    const updated: Record<string, ManifestStatus> = {};
    results.forEach((result, index) => {
      const workspaceId = ws[index].id;
      if (result.status === 'fulfilled') {
        const { data } = result.value;
        if (data.status === 'outdated') {
          updated[workspaceId] = { status: 'outdated', differences: data.differences };
        } else if (data.status === 'missing_token') {
          updated[workspaceId] = { status: 'missing_token', message: data.message || 'Reconnect required' };
        } else {
          updated[workspaceId] = { status: 'up_to_date' };
        }
      } else {
        updated[workspaceId] = {
          status: 'error',
          message: extractErrorMessage(result.reason, 'Failed to check manifest status'),
        };
      }
    });

    setManifestStatuses(prev => ({ ...prev, ...updated }));
  }, []);

  const handleUpdateManifest = async () => {
    if (!updateModalWorkspace) return;
    setUpdating(true);
    try {
      await api.post('/api/admin/slack-app/update-manifest', {
        workspaceId: updateModalWorkspace.id,
      });
      toast.success('Manifest updated successfully');
      setUpdateModalOpen(false);
      setUpdateModalWorkspace(null);
      checkManifestStatuses(workspaces);
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, 'Failed to update manifest'));
    } finally {
      setUpdating(false);
    }
  };

  const handleReconnect = async () => {
    if (!reconnectModalWorkspace || !reconnectToken.trim()) return;
    setReconnecting(true);
    setReconnectError(null);
    try {
      await api.post('/api/admin/slack-app/reconnect', {
        workspaceId: reconnectModalWorkspace.id,
        configToken: reconnectToken,
      });
      toast.success('Configuration token stored successfully');
      setReconnectModalOpen(false);
      setReconnectModalWorkspace(null);
      setReconnectToken('');
      checkManifestStatuses(workspaces);
    } catch (error: unknown) {
      setReconnectError(extractErrorMessage(error, 'Failed to store configuration token'));
    } finally {
      setReconnecting(false);
    }
  };

  const fetchWorkspaces = async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/admin/slack-workspaces');
      setWorkspaces(response.data.workspaces);
      checkManifestStatuses(response.data.workspaces);
    } catch (error) {
      console.error('Error fetching workspaces:', error);
      toast.error('Failed to load Slack workspaces');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const fetch = async () => {
      setLoading(true);
      try {
        const response = await api.get('/api/admin/slack-workspaces');
        if (!cancelled) {
          setWorkspaces(response.data.workspaces);
          checkManifestStatuses(response.data.workspaces);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error fetching workspaces:', error);
          toast.error('Failed to load Slack workspaces');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetch();
    return () => {
      cancelled = true;
    };
  }, [checkManifestStatuses]);

  const handleExportClick = (workspace: SlackWorkspace) => {
    setSelectedWorkspace(workspace);
    setExportModalOpen(true);
  };

  const handleDeactivateClick = (workspace: SlackWorkspace) => {
    setSelectedWorkspace(workspace);
    setDeactivateModalOpen(true);
  };

  const handleDeactivateConfirm = async () => {
    if (!selectedWorkspace) return;

    setDeactivating(true);
    try {
      await api.patch('/api/admin/slack-workspaces', {
        workspaceId: selectedWorkspace.id,
        action: 'deactivate',
      });

      logEvent({
        type: SlackEvents.WORKSPACE_DEACTIVATED,
        metadata: {
          workspaceId: selectedWorkspace.id,
          workspaceName: selectedWorkspace.name,
        },
      });

      toast.success(`Workspace "${selectedWorkspace.name}" deactivated`);
      setDeactivateModalOpen(false);
      setSelectedWorkspace(null);
      fetchWorkspaces();
    } catch (error) {
      console.error('Error deactivating workspace:', error);
      toast.error('Failed to deactivate workspace');
    } finally {
      setDeactivating(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // Export modal state
  const [exportChannelId, setExportChannelId] = useState('');
  const [exportFormat, setExportFormat] = useState<'json' | 'csv' | 'markdown'>('json');
  const [exportIncludeThreads, setExportIncludeThreads] = useState(true);
  const [exportIncludeUserNames, setExportIncludeUserNames] = useState(true);
  const [exportDateStart, setExportDateStart] = useState('');
  const [exportDateEnd, setExportDateEnd] = useState('');
  const [exporting, setExporting] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>('');

  // Async export state
  const [useAsyncExport, setUseAsyncExport] = useState(false);
  const [asyncJob, setAsyncJob] = useState<AsyncExportJob | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const pollJobStatus = useCallback(async (jobId: string) => {
    try {
      const response = await api.get(`/api/slack/export/status/${jobId}`);
      const job = response.data.job as AsyncExportJob;
      setAsyncJob(job);

      if (job.status === 'completed') {
        toast.success('Export completed! Click Download to get your file.');
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      } else if (job.status === 'failed') {
        toast.error(`Export failed: ${job.errorMessage || 'Unknown error'}`);
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      } else if (job.status === 'cancelled') {
        toast.info('Export was cancelled');
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      }
    } catch (error) {
      console.error('Error polling job status:', error);
    }
  }, []);

  const startPolling = useCallback(
    (jobId: string) => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }

      pollJobStatus(jobId);

      pollingIntervalRef.current = setInterval(() => {
        pollJobStatus(jobId);
      }, 2000);
    },
    [pollJobStatus]
  );

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  const cancelAsyncExport = async () => {
    if (!asyncJob) return;

    try {
      await api.delete(`/api/slack/export/status/${asyncJob.id}`);
      setAsyncJob(prev => (prev ? { ...prev, status: 'cancelled' as const } : null));
      toast.success('Export cancelled');

      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to cancel export');
    }
  };

  // Channel info state (for pre-export validation)
  interface ChannelInfo {
    id: string;
    name: string;
    isPrivate: boolean;
    isArchived: boolean;
    memberCount: number;
    estimatedMessageCount: number | null;
    oldestMessageTs: string | null;
    latestMessageTs: string | null;
    warning: string | null;
  }
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [checkingChannel, setCheckingChannel] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);

  const checkChannelInfo = async () => {
    if (!selectedWorkspace || !exportChannelId) {
      setChannelError('Please enter a channel ID');
      return;
    }

    setCheckingChannel(true);
    setChannelError(null);
    setChannelInfo(null);

    try {
      const response = await api.post('/api/slack/export/channel-info', {
        workspaceId: selectedWorkspace.id,
        channelId: exportChannelId,
      });

      setChannelInfo(response.data);

      // If channel is very large and no date filter, suggest Last 30 days
      if (
        response.data.estimatedMessageCount &&
        response.data.estimatedMessageCount > 10000 &&
        !exportDateStart &&
        !exportDateEnd
      ) {
        applyDatePreset('last30');
      }
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Failed to check channel';
      setChannelError(errorMessage);
    } finally {
      setCheckingChannel(false);
    }
  };

  const handleChannelIdChange = (value: string) => {
    setExportChannelId(value);
    setChannelInfo(null);
    setChannelError(null);
  };

  // Date range preset helpers
  const applyDatePreset = (preset: string) => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    let start = '';
    let end = today;

    switch (preset) {
      case 'last7': {
        const d = new Date(now);
        d.setDate(d.getDate() - 7);
        start = d.toISOString().split('T')[0];
        break;
      }
      case 'last30': {
        const d = new Date(now);
        d.setDate(d.getDate() - 30);
        start = d.toISOString().split('T')[0];
        break;
      }
      case 'thisMonth': {
        start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        break;
      }
      case 'lastMonth': {
        const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        start = firstOfLastMonth.toISOString().split('T')[0];
        end = lastOfLastMonth.toISOString().split('T')[0];
        break;
      }
      case 'allTime':
        start = '';
        end = '';
        break;
      default:
        return;
    }

    setExportDateStart(start);
    setExportDateEnd(end);
    setSelectedPreset(preset);
  };

  const handleExportConfirm = async () => {
    if (!selectedWorkspace || !exportChannelId) {
      toast.error('Please enter a channel ID');
      return;
    }

    setExporting(true);

    interface ExportPayload {
      workspaceId: string;
      channelId: string;
      format: 'json' | 'csv' | 'markdown';
      includeThreads: boolean;
      includeUserNames: boolean;
      dateRange?: {
        start?: string;
        end?: string;
      };
    }

    const payload: ExportPayload = {
      workspaceId: selectedWorkspace.id,
      channelId: exportChannelId,
      format: exportFormat,
      includeThreads: exportIncludeThreads,
      includeUserNames: exportIncludeUserNames,
    };

    if (exportDateStart || exportDateEnd) {
      payload.dateRange = {};
      if (exportDateStart) payload.dateRange.start = new Date(exportDateStart).toISOString();
      if (exportDateEnd) payload.dateRange.end = new Date(exportDateEnd).toISOString();
    }

    logEvent({
      type: SlackEvents.CHANNEL_EXPORT_STARTED,
      metadata: {
        workspaceId: selectedWorkspace.id,
        channelId: exportChannelId,
        format: exportFormat,
        isAsync: useAsyncExport,
      },
    });

    if (useAsyncExport) {
      try {
        const response = await api.post('/api/slack/export/async', payload);
        const jobId = response.data.jobId;

        toast.success('Export started in background. You can track progress here.');

        startPolling(jobId);

        // Reset form but keep modal open to show progress
        setExportChannelId('');
        setExportDateStart('');
        setExportDateEnd('');
        setSelectedPreset('');
        setChannelInfo(null);
      } catch (error: any) {
        console.error('Error starting async export:', error);
        const errorMessage = error.response?.data?.message || 'Failed to start export';
        toast.error(errorMessage);
      } finally {
        setExporting(false);
      }
      return;
    }

    // Synchronous export (immediate download)
    try {
      const response = await api.post('/api/slack/export/channel', payload, {
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;

      // Extract filename from Content-Disposition header or use default
      const contentDisposition = response.headers['content-disposition'];
      const fileNameMatch = contentDisposition?.match(/filename="(.+)"/);
      const fileName = fileNameMatch?.[1] || `slack-export-${exportChannelId}.${exportFormat}`;

      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      // Check for partial export via custom header
      const exportStatus = response.headers['x-export-status'];
      const warningCount = response.headers['x-export-warning-count'];

      if (exportStatus === 'partial') {
        toast.warning(
          `Partial export completed with ${warningCount || 'some'} warnings. Check the exported file for details.`,
          {
            duration: 6000,
          }
        );
      } else {
        toast.success('Channel exported successfully!');
      }

      logEvent({
        type: SlackEvents.CHANNEL_EXPORT_COMPLETED,
        metadata: {
          workspaceId: selectedWorkspace.id,
          channelId: exportChannelId,
        },
      });

      setExportModalOpen(false);
      setExportChannelId('');
      setExportDateStart('');
      setExportDateEnd('');
      setSelectedWorkspace(null);
    } catch (error: any) {
      console.error('Error exporting channel:', error);

      logEvent({
        type: SlackEvents.CHANNEL_EXPORT_FAILED,
        metadata: {
          workspaceId: selectedWorkspace.id,
          channelId: exportChannelId,
          error: error.message || 'Unknown error',
        },
      });

      let errorMessage = 'Failed to export channel';
      let suggestion = '';
      const statusCode = error.response?.status;

      // Check for gateway timeout (504) - CloudFront returns HTML, not JSON
      if (statusCode === 504) {
        errorMessage = 'Export timed out (Gateway Timeout)';
        suggestion =
          'This channel has too many messages for a single export. Enable "Background Export" above or use date range filters.';
      }
      else if (statusCode === 408 || error.code === 'ECONNABORTED') {
        errorMessage = 'Export request timed out';
        suggestion = 'Enable "Background Export" for large channels, or use a narrower date range.';
      }
      else if (statusCode === 413) {
        errorMessage = 'Channel too large to export';
        suggestion = 'Please use date filters to export smaller batches, or enable "Background Export".';
      }
      // Handle blob error responses - when responseType is 'blob', error data is also a blob
      else if (error.response?.data instanceof Blob) {
        try {
          const text = await error.response.data.text();

          // Check if it's HTML (CloudFront error page) vs JSON
          if (text.includes('<!DOCTYPE') || text.includes('<HTML>') || text.includes('<html>')) {
            if (text.includes('504') || text.includes('Gateway Timeout')) {
              errorMessage = 'Export timed out (Gateway Timeout)';
              suggestion = 'Enable "Background Export" above for large channels.';
            } else if (text.includes('502') || text.includes('Bad Gateway')) {
              errorMessage = 'Server temporarily unavailable';
              suggestion = 'Please wait a moment and try again.';
            } else {
              errorMessage = 'Export failed due to server error';
              suggestion = 'Please try again. If the issue persists, enable "Background Export".';
            }
          } else {
            const parsed = JSON.parse(text);
            errorMessage = parsed.message || errorMessage;
            // Check if this is actually a partial export returned as error
            if (parsed.export_status === 'partial' && parsed.messages?.length > 0) {
              // Re-trigger download for partial export
              const url = window.URL.createObjectURL(new Blob([text], { type: 'application/json' }));
              const link = document.createElement('a');
              link.href = url;
              link.setAttribute('download', `slack-export-partial-${exportChannelId}.json`);
              document.body.appendChild(link);
              link.click();
              link.remove();
              window.URL.revokeObjectURL(url);

              toast.warning(`Partial export: ${parsed.message}. Downloaded ${parsed.messages.length} messages.`, {
                duration: 8000,
              });
              return;
            }
            suggestion = parsed.error?.suggestion || '';
          }
        } catch {
          // If we can't parse the blob at all, check content type
          const contentType = error.response?.headers?.['content-type'] || '';
          if (contentType.includes('text/html')) {
            errorMessage = 'Export failed due to server timeout';
            suggestion = 'Enable "Background Export" for large channels.';
          }
        }
      } else if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
        suggestion = error.response.data.error?.suggestion || '';
      }

      if (suggestion) {
        toast.error(
          <div>
            <strong>{errorMessage}</strong>
            <br />
            <span style={{ fontSize: '0.9em', opacity: 0.9 }}>{suggestion}</span>
          </div>,
          { duration: 8000 }
        );
      } else {
        toast.error(errorMessage);
      }
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2 }}>
      {/* Header */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        gap={1}
        sx={{ mb: 3 }}
      >
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Image src="/icons/Slack_Logo.svg" alt="Slack" width={28} height={28} />
          <Typography level="h3">Slack Workspaces</Typography>
          <ContextHelpButton helpId="admin/slack-workspaces" tooltipText="Slack Workspaces Help" />
          <Chip size="sm" variant="soft" color="neutral">
            {workspaces.length} connected
          </Chip>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ width: { xs: '100%', sm: 'auto' } }}>
          {isMobile ? (
            <>
              <Tooltip title="Create Slack App">
                <IconButton
                  variant="solid"
                  color="primary"
                  onClick={() => setCreateAppModalOpen(true)}
                  size="sm"
                  data-testid="slack-create-app-btn"
                >
                  <Add />
                </IconButton>
              </Tooltip>
              <Tooltip title="Refresh">
                <IconButton
                  variant="outlined"
                  color="neutral"
                  onClick={fetchWorkspaces}
                  size="sm"
                  data-testid="slack-workspaces-refresh-btn"
                >
                  <Refresh />
                </IconButton>
              </Tooltip>
            </>
          ) : (
            <>
              <Button
                variant="solid"
                color="primary"
                startDecorator={<Add />}
                onClick={() => setCreateAppModalOpen(true)}
                size="sm"
                data-testid="slack-create-app-btn"
              >
                Create Slack App
              </Button>
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<Refresh />}
                onClick={fetchWorkspaces}
                size="sm"
                data-testid="slack-workspaces-refresh-btn"
              >
                Refresh
              </Button>
            </>
          )}
        </Stack>
      </Stack>

      {/* Description */}
      <Typography level="body-sm" sx={{ mb: 3, color: 'text.secondary' }}>
        Manage Slack workspaces connected via OAuth. Deactivating a workspace will stop the bot from responding to
        messages in that workspace.
      </Typography>

      {/* Table */}
      {workspaces.length === 0 ? (
        <Box
          sx={{
            textAlign: 'center',
            py: 6,
            px: 2,
            border: '1px dashed',
            borderColor: 'divider',
            borderRadius: 'md',
          }}
        >
          <Image src="/icons/Slack_Logo.svg" alt="Slack" width={48} height={48} style={{ opacity: 0.5 }} />
          <Typography level="h4" sx={{ mt: 2, mb: 1 }}>
            No workspaces connected
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            Workspaces will appear here when users install the bot via OAuth at <code>/integrations/slack/install</code>
          </Typography>
        </Box>
      ) : isMobile ? (
        <Stack spacing={1}>
          {workspaces.map(workspace => {
            const isInstalled = !!workspace.installedAt;
            const teamIdOrId = workspace.slackTeamId || workspace.id;
            const ms = manifestStatuses[workspace.id];

            const manifestNode = (() => {
              if (!ms || ms.status === 'checking') {
                return <CircularProgress size="sm" data-testid={`manifest-status-loading-${workspace.id}`} />;
              }
              if (ms.status === 'up_to_date') {
                return (
                  <Chip
                    size="sm"
                    variant="soft"
                    color="success"
                    startDecorator={<CheckCircle sx={{ fontSize: 14 }} />}
                    data-testid={`manifest-status-ok-${workspace.id}`}
                  >
                    Up to date
                  </Chip>
                );
              }
              if (ms.status === 'outdated') {
                return (
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Chip
                      size="sm"
                      variant="soft"
                      color="warning"
                      startDecorator={<Update sx={{ fontSize: 14 }} />}
                      data-testid={`manifest-status-outdated-${workspace.id}`}
                    >
                      Update Available
                    </Chip>
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="warning"
                      title="Update manifest"
                      onClick={() => {
                        setUpdateModalWorkspace(workspace);
                        setUpdateModalOpen(true);
                      }}
                      data-testid={`manifest-update-btn-${workspace.id}`}
                    >
                      <Update sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Stack>
                );
              }
              if (ms.status === 'missing_token') {
                return (
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Chip
                      size="sm"
                      variant="soft"
                      color="danger"
                      startDecorator={<LinkOff sx={{ fontSize: 14 }} />}
                      data-testid={`manifest-status-missing-${workspace.id}`}
                    >
                      Reconnect
                    </Chip>
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      title="Reconnect configuration token"
                      onClick={() => {
                        setReconnectModalWorkspace(workspace);
                        setReconnectModalOpen(true);
                      }}
                      data-testid={`manifest-reconnect-btn-${workspace.id}`}
                    >
                      <LinkOff sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Stack>
                );
              }
              return (
                <Tooltip title={ms.message || 'Failed to check manifest status'} variant="soft">
                  <Chip size="sm" variant="soft" color="neutral" data-testid={`manifest-status-error-${workspace.id}`}>
                    Error
                  </Chip>
                </Tooltip>
              );
            })();

            return (
              <Card key={workspace.id} variant="outlined" sx={{ p: 1.5 }}>
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography level="title-sm" fontWeight="md">
                      {workspace.name}
                    </Typography>
                    <Chip size="sm" variant="soft" color={workspace.isActive ? 'success' : 'neutral'}>
                      {workspace.isActive ? 'Active' : 'Inactive'}
                    </Chip>
                  </Stack>
                  <Stack spacing={0.25}>
                    {workspace.slackTeamId && (
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                        Team: {workspace.slackTeamId}
                      </Typography>
                    )}
                    {workspace.slackAppId && (
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                        App: {workspace.slackAppId}
                      </Typography>
                    )}
                    {workspace.slackBotName && <Typography level="body-xs">Bot: {workspace.slackBotName}</Typography>}
                    {isInstalled ? (
                      <Typography level="body-xs">Installed: {formatDate(workspace.installedAt!)}</Typography>
                    ) : (
                      <Chip size="sm" variant="soft" color="warning">
                        Not Installed
                      </Chip>
                    )}
                  </Stack>
                  <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
                      {manifestNode}
                    </Stack>
                    <Stack direction="row" spacing={0.5}>
                      {isInstalled ? (
                        <Tooltip title="Export channel history">
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="primary"
                            onClick={() => handleExportClick(workspace)}
                            disabled={!workspace.isActive}
                            data-testid={`slack-workspace-export-btn-${teamIdOrId}`}
                          >
                            <Download />
                          </IconButton>
                        </Tooltip>
                      ) : (
                        <Button
                          size="sm"
                          variant="solid"
                          color="primary"
                          component="a"
                          href={`/integrations/slack/install?workspaceId=${workspace.id}`}
                          data-testid={`slack-workspace-install-btn-${workspace.id}`}
                        >
                          Install
                        </Button>
                      )}
                      <Tooltip title="Deactivate workspace">
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="danger"
                          onClick={() => handleDeactivateClick(workspace)}
                          disabled={!workspace.isActive}
                          data-testid={`slack-workspace-deactivate-btn-${teamIdOrId}`}
                        >
                          <Delete />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                </Stack>
              </Card>
            );
          })}
        </Stack>
      ) : (
        <Table
          aria-label="Slack workspaces table"
          sx={{
            '& thead th': { bgcolor: 'background.level1' },
            '& tbody tr:hover': { bgcolor: 'background.level1' },
          }}
        >
          <thead>
            <tr>
              <th style={{ width: '16%' }}>Workspace</th>
              <th style={{ width: '10%' }}>Team ID</th>
              <th style={{ width: '12%' }}>App ID</th>
              <th style={{ width: '12%' }}>Bot Name</th>
              <th style={{ width: '10%' }}>Installed</th>
              <th style={{ width: '8%' }}>Status</th>
              <th style={{ width: '16%' }}>Manifest</th>
              <th style={{ width: '16%', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map(workspace => {
              const isInstalled = !!workspace.installedAt;
              const teamIdOrId = workspace.slackTeamId || workspace.id;

              return (
                <tr key={workspace.id}>
                  <td>
                    <Typography level="body-sm" fontWeight="md">
                      {workspace.name}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                      {workspace.slackTeamId || '-'}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                      {workspace.slackAppId || '-'}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-sm">{workspace.slackBotName || '-'}</Typography>
                  </td>
                  <td>
                    {isInstalled ? (
                      <Typography level="body-sm">{formatDate(workspace.installedAt!)}</Typography>
                    ) : (
                      <Chip size="sm" variant="soft" color="warning">
                        Not Installed
                      </Chip>
                    )}
                  </td>
                  <td>
                    <Chip size="sm" variant="soft" color={workspace.isActive ? 'success' : 'neutral'}>
                      {workspace.isActive ? 'Active' : 'Inactive'}
                    </Chip>
                  </td>
                  <td>
                    {(() => {
                      const ms = manifestStatuses[workspace.id];
                      if (!ms || ms.status === 'checking') {
                        return <CircularProgress size="sm" data-testid={`manifest-status-loading-${workspace.id}`} />;
                      }
                      if (ms.status === 'up_to_date') {
                        return (
                          <Chip
                            size="sm"
                            variant="soft"
                            color="success"
                            startDecorator={<CheckCircle sx={{ fontSize: 14 }} />}
                            data-testid={`manifest-status-ok-${workspace.id}`}
                          >
                            Up to date
                          </Chip>
                        );
                      }
                      if (ms.status === 'outdated') {
                        return (
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Chip
                              size="sm"
                              variant="soft"
                              color="warning"
                              startDecorator={<Update sx={{ fontSize: 14 }} />}
                              data-testid={`manifest-status-outdated-${workspace.id}`}
                            >
                              Update Available
                            </Chip>
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="warning"
                              title="Update manifest"
                              onClick={() => {
                                setUpdateModalWorkspace(workspace);
                                setUpdateModalOpen(true);
                              }}
                              data-testid={`manifest-update-btn-${workspace.id}`}
                            >
                              <Update sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Stack>
                        );
                      }
                      if (ms.status === 'missing_token') {
                        return (
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Chip
                              size="sm"
                              variant="soft"
                              color="danger"
                              startDecorator={<LinkOff sx={{ fontSize: 14 }} />}
                              data-testid={`manifest-status-missing-${workspace.id}`}
                            >
                              Reconnect
                            </Chip>
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="danger"
                              title="Reconnect configuration token"
                              onClick={() => {
                                setReconnectModalWorkspace(workspace);
                                setReconnectModalOpen(true);
                              }}
                              data-testid={`manifest-reconnect-btn-${workspace.id}`}
                            >
                              <LinkOff sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Stack>
                        );
                      }
                      // error state
                      return (
                        <Tooltip title={ms.message || 'Failed to check manifest status'} variant="soft">
                          <Chip
                            size="sm"
                            variant="soft"
                            color="neutral"
                            data-testid={`manifest-status-error-${workspace.id}`}
                          >
                            Error
                          </Chip>
                        </Tooltip>
                      );
                    })()}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      {isInstalled ? (
                        <>
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="primary"
                            onClick={() => handleExportClick(workspace)}
                            disabled={!workspace.isActive}
                            title="Export channel history"
                            data-testid={`slack-workspace-export-btn-${teamIdOrId}`}
                          >
                            <Download />
                          </IconButton>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="solid"
                          color="primary"
                          component="a"
                          href={`/integrations/slack/install?workspaceId=${workspace.id}`}
                          data-testid={`slack-workspace-install-btn-${workspace.id}`}
                        >
                          Install
                        </Button>
                      )}
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="danger"
                        onClick={() => handleDeactivateClick(workspace)}
                        disabled={!workspace.isActive}
                        title="Deactivate workspace"
                        data-testid={`slack-workspace-deactivate-btn-${teamIdOrId}`}
                      >
                        <Delete />
                      </IconButton>
                    </Stack>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {/* Deactivate Confirmation Modal */}
      <Modal
        open={deactivateModalOpen}
        onClose={() => {
          setDeactivateModalOpen(false);
          setSelectedWorkspace(null);
        }}
      >
        <ModalDialog variant="outlined" role="alertdialog">
          <DialogTitle>
            <Warning sx={{ color: 'warning.500', mr: 1 }} />
            Deactivate Workspace
          </DialogTitle>
          <DialogContent>
            <Typography level="body-md">
              Are you sure you want to deactivate <strong>{selectedWorkspace?.name}</strong>?
            </Typography>
            <Typography level="body-sm" sx={{ mt: 1, color: 'text.secondary' }}>
              The bot will stop responding to messages in this workspace. The workspace can be reconnected by
              reinstalling via OAuth.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => {
                setDeactivateModalOpen(false);
                setSelectedWorkspace(null);
              }}
              data-testid="slack-workspace-deactivate-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="danger"
              onClick={handleDeactivateConfirm}
              loading={deactivating}
              data-testid="slack-workspace-deactivate-confirm-btn"
            >
              Deactivate
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Export Channel Modal */}
      <Modal
        open={exportModalOpen}
        onClose={() => {
          if (!exporting && (!asyncJob || asyncJob.status !== 'processing')) {
            setExportModalOpen(false);
            setSelectedWorkspace(null);
            setExportChannelId('');
            setExportDateStart('');
            setExportDateEnd('');
            setSelectedPreset('');
            setChannelInfo(null);
            setChannelError(null);
            setAsyncJob(null);
            setUseAsyncExport(false);
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
          }
        }}
      >
        <ModalDialog variant="outlined" sx={{ minWidth: { xs: '95vw', sm: 500 }, maxWidth: { xs: '95vw', sm: 600 } }}>
          <DialogTitle>
            <Download sx={{ color: 'primary.500', mr: 1 }} />
            Export Slack Channel
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 1 }}>
                Export complete channel history for <strong>{selectedWorkspace?.name}</strong>
              </Typography>

              {/* Bot membership guidance */}
              <Alert
                color="neutral"
                variant="soft"
                startDecorator={<InfoOutlined />}
                sx={{ mb: 1 }}
                data-testid="slack-export-bot-guidance-alert"
              >
                <Box>
                  <Typography level="body-sm">
                    <strong>Requirement:</strong> The {selectedWorkspace?.slackBotName || 'Slack bot'} must be a member
                    of the channel you want to export. In Slack, type{' '}
                    <code>/invite @{selectedWorkspace?.slackBotName || 'Slack bot'}</code> in the channel to add it.
                  </Typography>
                  <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
                    For private channels, you must have permission to invite bots.
                  </Typography>
                </Box>
              </Alert>

              <FormControl required>
                <FormLabel>Channel ID</FormLabel>
                <Stack direction="row" spacing={1}>
                  <Input
                    placeholder="C01234ABCDE"
                    value={exportChannelId}
                    onChange={e => handleChannelIdChange(e.target.value)}
                    disabled={exporting || checkingChannel}
                    slotProps={{
                      input: { 'data-testid': 'slack-export-channel-id-input' },
                    }}
                    sx={{ flex: 1 }}
                  />
                  <Button
                    variant="soft"
                    color="neutral"
                    onClick={checkChannelInfo}
                    disabled={!exportChannelId || exporting || checkingChannel}
                    loading={checkingChannel}
                    data-testid="slack-export-check-channel-btn"
                  >
                    Check
                  </Button>
                </Stack>
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.secondary' }}>
                  Right-click channel → Copy link → Extract ID from URL
                </Typography>
              </FormControl>

              {/* Channel Info Display */}
              {channelError && (
                <Alert color="danger" variant="soft" startDecorator={<Warning />}>
                  {channelError}
                </Alert>
              )}

              {channelInfo && (
                <Card variant="soft" color={channelInfo.warning ? 'warning' : 'success'} sx={{ p: 2 }}>
                  <Stack spacing={1}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Typography level="title-sm">#{channelInfo.name}</Typography>
                      {channelInfo.isPrivate && (
                        <Chip size="sm" variant="soft" color="neutral">
                          Private
                        </Chip>
                      )}
                      {channelInfo.isArchived && (
                        <Chip size="sm" variant="soft" color="warning">
                          Archived
                        </Chip>
                      )}
                    </Stack>

                    <Stack direction="row" spacing={2}>
                      <Typography level="body-xs">
                        <strong>Est. messages:</strong>{' '}
                        {channelInfo.estimatedMessageCount !== null
                          ? channelInfo.estimatedMessageCount.toLocaleString()
                          : 'Unknown'}
                      </Typography>
                      <Typography level="body-xs">
                        <strong>Members:</strong> {channelInfo.memberCount.toLocaleString()}
                      </Typography>
                    </Stack>

                    {channelInfo.oldestMessageTs && (
                      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                        First message: {new Date(parseFloat(channelInfo.oldestMessageTs) * 1000).toLocaleDateString()}
                      </Typography>
                    )}

                    {channelInfo.warning && (
                      <Alert color="warning" variant="outlined" size="sm" sx={{ mt: 1 }}>
                        <Typography level="body-xs">{channelInfo.warning}</Typography>
                      </Alert>
                    )}
                  </Stack>
                </Card>
              )}

              <FormControl>
                <FormLabel>Export Format</FormLabel>
                <Select
                  value={exportFormat}
                  onChange={(_, value) => setExportFormat(value as 'json' | 'csv' | 'markdown')}
                  disabled={exporting}
                  data-testid="slack-export-format-select"
                >
                  <Option value="json">JSON (structured data)</Option>
                  <Option value="csv">CSV (spreadsheet)</Option>
                  <Option value="markdown">Markdown (readable)</Option>
                </Select>
              </FormControl>

              <FormControl>
                <FormLabel>Date Range</FormLabel>
                <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', gap: 0.5 }}>
                  <Chip
                    size="sm"
                    variant={selectedPreset === 'last7' ? 'solid' : 'soft'}
                    color={selectedPreset === 'last7' ? 'primary' : 'neutral'}
                    onClick={() => applyDatePreset('last7')}
                    sx={{ cursor: 'pointer' }}
                    disabled={exporting}
                    data-testid="slack-export-preset-last7"
                  >
                    Last 7 days
                  </Chip>
                  <Chip
                    size="sm"
                    variant={selectedPreset === 'last30' ? 'solid' : 'soft'}
                    color={selectedPreset === 'last30' ? 'primary' : 'neutral'}
                    onClick={() => applyDatePreset('last30')}
                    sx={{ cursor: 'pointer' }}
                    disabled={exporting}
                    data-testid="slack-export-preset-last30"
                  >
                    Last 30 days
                  </Chip>
                  <Chip
                    size="sm"
                    variant={selectedPreset === 'thisMonth' ? 'solid' : 'soft'}
                    color={selectedPreset === 'thisMonth' ? 'primary' : 'neutral'}
                    onClick={() => applyDatePreset('thisMonth')}
                    sx={{ cursor: 'pointer' }}
                    disabled={exporting}
                    data-testid="slack-export-preset-thisMonth"
                  >
                    This month
                  </Chip>
                  <Chip
                    size="sm"
                    variant={selectedPreset === 'lastMonth' ? 'solid' : 'soft'}
                    color={selectedPreset === 'lastMonth' ? 'primary' : 'neutral'}
                    onClick={() => applyDatePreset('lastMonth')}
                    sx={{ cursor: 'pointer' }}
                    disabled={exporting}
                    data-testid="slack-export-preset-lastMonth"
                  >
                    Last month
                  </Chip>
                  <Chip
                    size="sm"
                    variant={selectedPreset === 'allTime' ? 'solid' : 'soft'}
                    color={selectedPreset === 'allTime' ? 'primary' : 'neutral'}
                    onClick={() => applyDatePreset('allTime')}
                    sx={{ cursor: 'pointer' }}
                    disabled={exporting}
                    data-testid="slack-export-preset-allTime"
                  >
                    All time
                  </Chip>
                </Stack>
                <Stack direction="row" spacing={2}>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>Start Date</FormLabel>
                    <Input
                      type="date"
                      value={exportDateStart}
                      onChange={e => {
                        setExportDateStart(e.target.value);
                        setSelectedPreset(''); // Clear preset when manually editing
                      }}
                      disabled={exporting}
                      slotProps={{
                        input: { 'data-testid': 'slack-export-date-start-input' },
                      }}
                    />
                  </FormControl>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>End Date</FormLabel>
                    <Input
                      type="date"
                      value={exportDateEnd}
                      onChange={e => {
                        setExportDateEnd(e.target.value);
                        setSelectedPreset(''); // Clear preset when manually editing
                      }}
                      disabled={exporting}
                      slotProps={{
                        input: { 'data-testid': 'slack-export-date-end-input' },
                      }}
                    />
                  </FormControl>
                </Stack>
              </FormControl>

              {!exportDateStart && !exportDateEnd && (
                <Alert color="warning" size="sm" data-testid="slack-export-no-date-warning">
                  <Typography level="body-xs">
                    Exporting without date filters may timeout on large channels. Consider adding a date range for
                    channels with many messages.
                  </Typography>
                </Alert>
              )}

              <Stack spacing={1}>
                <Checkbox
                  label="Include thread replies"
                  checked={exportIncludeThreads}
                  onChange={e => setExportIncludeThreads(e.target.checked)}
                  disabled={exporting}
                  data-testid="slack-export-include-threads-checkbox"
                />
                <Checkbox
                  label="Include user names (resolves user IDs)"
                  checked={exportIncludeUserNames}
                  onChange={e => setExportIncludeUserNames(e.target.checked)}
                  disabled={exporting}
                  data-testid="slack-export-include-usernames-checkbox"
                />
              </Stack>

              <Divider />

              {/* Background Export Toggle */}
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography level="title-sm">Background Export</Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    Process large channels in background (up to 15 minutes)
                  </Typography>
                </Box>
                <Switch
                  checked={useAsyncExport}
                  onChange={e => setUseAsyncExport(e.target.checked)}
                  disabled={exporting || asyncJob?.status === 'processing' || asyncJob?.status === 'pending'}
                  data-testid="slack-export-async-toggle"
                />
              </Stack>

              {/* Async Export Progress */}
              {asyncJob && (
                <Card
                  variant="soft"
                  color={
                    asyncJob.status === 'completed'
                      ? 'success'
                      : asyncJob.status === 'failed'
                        ? 'danger'
                        : asyncJob.status === 'cancelled'
                          ? 'neutral'
                          : 'primary'
                  }
                  sx={{ p: 2 }}
                >
                  <Stack spacing={1.5}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between">
                      <Stack direction="row" alignItems="center" spacing={1}>
                        {asyncJob.status === 'completed' && <CheckCircle fontSize="small" color="success" />}
                        {asyncJob.status === 'failed' && <Error fontSize="small" color="error" />}
                        {asyncJob.status === 'cancelled' && <Cancel fontSize="small" color="disabled" />}
                        {(asyncJob.status === 'processing' || asyncJob.status === 'pending') && (
                          <CircularProgress size="sm" />
                        )}
                        <Typography level="title-sm">
                          {asyncJob.status === 'completed' && 'Export Complete'}
                          {asyncJob.status === 'failed' && 'Export Failed'}
                          {asyncJob.status === 'cancelled' && 'Export Cancelled'}
                          {asyncJob.status === 'processing' && 'Exporting...'}
                          {asyncJob.status === 'pending' && 'Starting...'}
                        </Typography>
                      </Stack>
                      {(asyncJob.status === 'processing' || asyncJob.status === 'pending') && (
                        <Button
                          size="sm"
                          variant="soft"
                          color="danger"
                          onClick={cancelAsyncExport}
                          startDecorator={<Cancel />}
                          data-testid="slack-export-cancel-async-btn"
                        >
                          Cancel
                        </Button>
                      )}
                    </Stack>

                    {(asyncJob.status === 'processing' || asyncJob.status === 'pending') && (
                      <>
                        <LinearProgress determinate value={asyncJob.progress} />
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          {asyncJob.currentStep}
                          {asyncJob.processedMessages !== undefined && asyncJob.processedMessages > 0 && (
                            <> • {asyncJob.processedMessages.toLocaleString()} messages</>
                          )}
                        </Typography>
                      </>
                    )}

                    {asyncJob.status === 'completed' && asyncJob.downloadUrl && (
                      <Stack spacing={1}>
                        <Typography level="body-xs">
                          {asyncJob.processedMessages?.toLocaleString()} messages exported
                          {asyncJob.fileSize && <> • {(asyncJob.fileSize / 1024).toFixed(1)} KB</>}
                        </Typography>
                        <Button
                          variant="solid"
                          color="success"
                          startDecorator={<Download />}
                          component="a"
                          href={asyncJob.downloadUrl}
                          download
                          data-testid="slack-export-download-btn"
                        >
                          Download Export
                        </Button>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Link expires:{' '}
                          {asyncJob.downloadExpiresAt
                            ? new Date(asyncJob.downloadExpiresAt).toLocaleString()
                            : 'in 1 hour'}
                        </Typography>
                      </Stack>
                    )}

                    {asyncJob.status === 'failed' && (
                      <Typography level="body-xs" color="danger">
                        {asyncJob.errorMessage || 'Unknown error occurred'}
                      </Typography>
                    )}
                  </Stack>
                </Card>
              )}

              {/* Sync Export Progress */}
              {exporting && !useAsyncExport && (
                <Box>
                  <LinearProgress />
                  <Typography level="body-sm" sx={{ mt: 1, textAlign: 'center', color: 'text.secondary' }}>
                    Exporting channel... This may take a while for large channels.
                  </Typography>
                </Box>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => {
                setExportModalOpen(false);
                setSelectedWorkspace(null);
                setExportChannelId('');
                setExportDateStart('');
                setExportDateEnd('');
                setSelectedPreset('');
                setChannelInfo(null);
                setChannelError(null);
                setAsyncJob(null);
                setUseAsyncExport(false);
                if (pollingIntervalRef.current) {
                  clearInterval(pollingIntervalRef.current);
                  pollingIntervalRef.current = null;
                }
              }}
              disabled={exporting || asyncJob?.status === 'processing' || asyncJob?.status === 'pending'}
              data-testid="slack-export-cancel-btn"
            >
              {asyncJob?.status === 'completed' || asyncJob?.status === 'failed' || asyncJob?.status === 'cancelled'
                ? 'Close'
                : 'Cancel'}
            </Button>
            {(!asyncJob || asyncJob.status === 'cancelled' || asyncJob.status === 'failed') && (
              <Button
                variant="solid"
                color="primary"
                onClick={handleExportConfirm}
                loading={exporting}
                disabled={!exportChannelId}
                data-testid="slack-export-confirm-btn"
              >
                {useAsyncExport ? 'Start Export' : 'Export'}
              </Button>
            )}
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Update Manifest Confirmation Modal */}
      <Modal
        open={updateModalOpen}
        onClose={() => {
          if (!updating) {
            setUpdateModalOpen(false);
            setUpdateModalWorkspace(null);
          }
        }}
      >
        <ModalDialog variant="outlined" role="alertdialog">
          <DialogTitle>
            <Update sx={{ color: 'warning.500', mr: 1 }} />
            Update Manifest
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-md">
                Update the manifest for{' '}
                <strong>{updateModalWorkspace?.name || updateModalWorkspace?.slackAppId}</strong>?
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                This will update scopes, events, commands, and interactivity settings. Your app&apos;s name,
                description, and color will not be changed.
              </Typography>
              {(() => {
                const ms = updateModalWorkspace ? manifestStatuses[updateModalWorkspace.id] : undefined;
                const diffs = ms?.status === 'outdated' ? ms.differences : undefined;
                if (!diffs) return null;
                return (
                  <Box
                    sx={{
                      maxHeight: 200,
                      overflow: 'auto',
                      bgcolor: 'background.level1',
                      borderRadius: 'sm',
                      p: 1.5,
                    }}
                  >
                    <Typography level="title-sm" sx={{ mb: 1 }}>
                      Changes to apply:
                    </Typography>
                    {diffs.map((diff: ManifestDifference, i: number) => (
                      <Box key={i} sx={{ mb: 1 }}>
                        <Typography level="body-xs" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                          {diff.field}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'danger.500' }}>
                          - {JSON.stringify(diff.actual)}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'success.500' }}>
                          + {JSON.stringify(diff.expected)}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                );
              })()}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => {
                setUpdateModalOpen(false);
                setUpdateModalWorkspace(null);
              }}
              disabled={updating}
              data-testid="manifest-update-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="warning"
              onClick={handleUpdateManifest}
              loading={updating}
              data-testid="manifest-update-confirm-btn"
            >
              Update Manifest
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Reconnect Configuration Token Modal */}
      <Modal
        open={reconnectModalOpen}
        onClose={() => {
          if (!reconnecting) {
            setReconnectModalOpen(false);
            setReconnectModalWorkspace(null);
            setReconnectToken('');
            setReconnectError(null);
          }
        }}
      >
        <ModalDialog variant="outlined" sx={{ minWidth: { xs: '95vw', sm: 450 } }}>
          <DialogTitle>
            <LinkOff sx={{ color: 'primary.500', mr: 1 }} />
            Reconnect Configuration Token
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                Provide a Slack app configuration token to enable manifest management for{' '}
                <strong>{reconnectModalWorkspace?.name || reconnectModalWorkspace?.slackAppId}</strong>.
              </Typography>
              <Alert color="neutral" variant="soft" startDecorator={<InfoOutlined />}>
                <Typography level="body-xs">
                  Go to{' '}
                  <a
                    href="https://api.slack.com/apps"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'inherit', textDecoration: 'underline' }}
                  >
                    api.slack.com/apps
                  </a>
                  , scroll below the app list, and find <strong>Your App Configuration Tokens</strong>. Click{' '}
                  <strong>Generate Token</strong> next to your workspace. Note: tokens expire after 12 hours.
                </Typography>
              </Alert>
              {reconnectError && (
                <Alert color="danger" variant="soft" size="sm">
                  {reconnectError}
                </Alert>
              )}
              <FormControl required>
                <FormLabel>Configuration Token</FormLabel>
                <Input
                  type="password"
                  value={reconnectToken}
                  onChange={e => setReconnectToken(e.target.value)}
                  placeholder="xoxe.xoxp-..."
                  disabled={reconnecting}
                  data-testid="reconnect-token-input"
                />
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => {
                setReconnectModalOpen(false);
                setReconnectModalWorkspace(null);
                setReconnectToken('');
                setReconnectError(null);
              }}
              disabled={reconnecting}
              data-testid="reconnect-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleReconnect}
              loading={reconnecting}
              disabled={!reconnectToken.trim()}
              data-testid="reconnect-confirm-btn"
            >
              Reconnect
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Create Slack App Modal */}
      <CreateSlackAppModal
        open={createAppModalOpen}
        onClose={() => setCreateAppModalOpen(false)}
        onSuccess={() => {
          toast.success('Slack app created successfully!');
          fetchWorkspaces(); // Refresh workspaces list to show the newly created app
        }}
      />
    </Box>
  );
};

export default SlackWorkspacesTab;
