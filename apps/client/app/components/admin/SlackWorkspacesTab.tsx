import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dropdown,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Link,
  Menu,
  MenuButton,
  MenuItem,
  Option,
  Select,
  Stack,
  Typography,
  Checkbox,
  LinearProgress,
  Switch,
  Divider,
  Tooltip,
} from '@mui/joy';
import Refresh from '@mui/icons-material/Refresh';
import Add from '@mui/icons-material/Add';
import Download from '@mui/icons-material/Download';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import MoreHoriz from '@mui/icons-material/MoreHoriz';
import Update from '@mui/icons-material/Update';
import LinkOff from '@mui/icons-material/LinkOff';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import CreateSlackAppModal from './CreateSlackAppModal';
import { SlackEvents } from '@bike4mind/common';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  LoadingState,
  StatusChip,
  UpdatingBar,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

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

const LOAD_ERROR = 'Slack workspaces failed to load.';

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const Mono: React.FC<{ children: ReactNode }> = ({ children }) => (
  <Typography component="span" level="body-xs" sx={{ fontFamily: 'code', color: 'admin.inkMuted' }}>
    {children}
  </Typography>
);

const NoValue = () => (
  <Box component="span" sx={{ color: 'admin.inkMuted' }}>
    -
  </Box>
);

/** The manifest check result for one workspace, with the fix one click away when it needs one. */
const ManifestCell: React.FC<{
  workspace: SlackWorkspace;
  status: ManifestStatus | undefined;
  onUpdate: () => void;
  onReconnect: () => void;
}> = ({ workspace, status, onUpdate, onReconnect }) => {
  if (!status || status.status === 'checking') {
    return <StatusChip tone="neutral" label="Checking" data-testid={`manifest-status-loading-${workspace.id}`} />;
  }
  if (status.status === 'up_to_date') {
    return <StatusChip tone="good" label="Up to date" data-testid={`manifest-status-ok-${workspace.id}`} />;
  }
  if (status.status === 'outdated') {
    return (
      <Stack direction="row" gap={0.5} alignItems="center">
        <StatusChip tone="warn" label="Update available" data-testid={`manifest-status-outdated-${workspace.id}`} />
        <Tooltip title="Update manifest">
          <IconButton
            size="sm"
            variant="plain"
            aria-label="Update manifest"
            onClick={onUpdate}
            data-testid={`manifest-update-btn-${workspace.id}`}
          >
            <Update />
          </IconButton>
        </Tooltip>
      </Stack>
    );
  }
  if (status.status === 'missing_token') {
    return (
      <Stack direction="row" gap={0.5} alignItems="center">
        <StatusChip tone="bad" label="Reconnect needed" data-testid={`manifest-status-missing-${workspace.id}`} />
        <Tooltip title="Reconnect configuration token">
          <IconButton
            size="sm"
            variant="plain"
            aria-label="Reconnect configuration token"
            onClick={onReconnect}
            data-testid={`manifest-reconnect-btn-${workspace.id}`}
          >
            <LinkOff />
          </IconButton>
        </Tooltip>
      </Stack>
    );
  }
  // A failed check says nothing about the manifest itself, so it stays neutral.
  return (
    <Tooltip title={status.message || 'Failed to check manifest status'}>
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <StatusChip tone="neutral" label="Check failed" data-testid={`manifest-status-error-${workspace.id}`} />
      </Box>
    </Tooltip>
  );
};

/** Cancel and commit buttons at the bottom-right of a dialog, as ActionDialog lays them out. */
const DialogFooter: React.FC<{ children: ReactNode }> = ({ children }) => (
  <Stack
    direction="row"
    justifyContent="flex-end"
    gap={1}
    flexWrap="wrap"
    sx={{ pt: 2, mt: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
  >
    {children}
  </Stack>
);

const SlackWorkspacesTab: React.FC = () => {
  const { mutate: logEvent } = useLogEvent();
  const [workspaces, setWorkspaces] = useState<SlackWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  // A refetch keeps the table on screen under UpdatingBar; LoadingState is only for the first load.
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    setRefreshing(true);
    try {
      const response = await api.get('/api/admin/slack-workspaces');
      setWorkspaces(response.data.workspaces);
      setLoadError(null);
      checkManifestStatuses(response.data.workspaces);
    } catch (error) {
      console.error('Error fetching workspaces:', error);
      setLoadError(LOAD_ERROR);
    } finally {
      setRefreshing(false);
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
          setLoadError(LOAD_ERROR);
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
  // The job whose cancel confirm is open.
  const [cancelJobId, setCancelJobId] = useState<string | null>(null);
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

  /** Resolves true once the job is cancelled; a failure is reported in a toast. */
  const cancelAsyncExport = async (): Promise<boolean> => {
    if (!asyncJob) return false;

    try {
      await api.delete(`/api/slack/export/status/${asyncJob.id}`);
      setAsyncJob(prev => (prev ? { ...prev, status: 'cancelled' as const } : null));
      toast.success('Export cancelled');

      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      return true;
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to cancel export');
      return false;
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
      } else if (statusCode === 408 || error.code === 'ECONNABORTED') {
        errorMessage = 'Export request timed out';
        suggestion = 'Enable "Background Export" for large channels, or use a narrower date range.';
      } else if (statusCode === 413) {
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

  const closeDeactivateDialog = () => {
    setDeactivateModalOpen(false);
    setSelectedWorkspace(null);
  };

  const resetExportDialog = () => {
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
  };

  const closeUpdateDialog = () => {
    setUpdateModalOpen(false);
    setUpdateModalWorkspace(null);
  };

  const closeReconnectDialog = () => {
    setReconnectModalOpen(false);
    setReconnectModalWorkspace(null);
    setReconnectToken('');
    setReconnectError(null);
  };

  const jobRunning = asyncJob?.status === 'processing' || asyncJob?.status === 'pending';
  const jobFinished =
    asyncJob?.status === 'completed' || asyncJob?.status === 'failed' || asyncJob?.status === 'cancelled';
  const updateStatus = updateModalWorkspace ? manifestStatuses[updateModalWorkspace.id] : undefined;
  const updateDiffs = updateStatus?.status === 'outdated' ? updateStatus.differences : undefined;

  const columns: DataColumn<SlackWorkspace>[] = [
    {
      id: 'name',
      label: 'Workspace',
      sortValue: workspace => workspace.name,
      render: workspace => workspace.name,
    },
    {
      id: 'team',
      label: 'Team ID',
      width: '7.5rem',
      render: workspace => (workspace.slackTeamId ? <Mono>{workspace.slackTeamId}</Mono> : <NoValue />),
    },
    {
      id: 'app',
      label: 'App ID',
      width: '7.5rem',
      render: workspace => (workspace.slackAppId ? <Mono>{workspace.slackAppId}</Mono> : <NoValue />),
    },
    {
      id: 'bot',
      label: 'Bot name',
      width: '8rem',
      render: workspace => workspace.slackBotName || <NoValue />,
    },
    {
      id: 'installed',
      label: 'Installed',
      width: '13rem',
      render: workspace =>
        workspace.installedAt ? (
          formatDate(workspace.installedAt)
        ) : (
          <Stack direction="row" gap={1} alignItems="center">
            <StatusChip
              tone="warn"
              label="Not installed"
              data-testid={`slack-workspace-not-installed-${workspace.id}`}
            />
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              component="a"
              href={`/integrations/slack/install?workspaceId=${workspace.id}`}
              data-testid={`slack-workspace-install-btn-${workspace.id}`}
            >
              Install
            </Button>
          </Stack>
        ),
    },
    {
      id: 'status',
      label: 'Status',
      width: '7rem',
      render: workspace => (
        <StatusChip
          tone={workspace.isActive ? 'good' : 'neutral'}
          label={workspace.isActive ? 'Active' : 'Inactive'}
          dot
          data-testid={`slack-workspace-status-${workspace.id}`}
        />
      ),
    },
    {
      id: 'manifest',
      label: 'Manifest',
      width: '12rem',
      render: workspace => (
        <ManifestCell
          workspace={workspace}
          status={manifestStatuses[workspace.id]}
          onUpdate={() => {
            setUpdateModalWorkspace(workspace);
            setUpdateModalOpen(true);
          }}
          onReconnect={() => {
            setReconnectModalWorkspace(workspace);
            setReconnectModalOpen(true);
          }}
        />
      ),
    },
  ];

  // One menu per row: DataTable's action column holds a single button, and Deactivate is destructive,
  // so it belongs in a menu rather than as a red icon in every row.
  const rowActions = (workspace: SlackWorkspace) => {
    const teamIdOrId = workspace.slackTeamId || workspace.id;
    return (
      <Dropdown>
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{ root: { size: 'sm', variant: 'plain' } }}
          aria-label={`More actions for ${workspace.name}`}
          data-testid={`slack-workspace-menu-btn-${teamIdOrId}`}
        >
          <MoreHoriz />
        </MenuButton>
        <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
          {workspace.installedAt && (
            <MenuItem
              disabled={!workspace.isActive}
              onClick={() => handleExportClick(workspace)}
              data-testid={`slack-workspace-export-btn-${teamIdOrId}`}
            >
              Export channel history
            </MenuItem>
          )}
          <MenuItem
            color="danger"
            disabled={!workspace.isActive}
            onClick={() => handleDeactivateClick(workspace)}
            data-testid={`slack-workspace-deactivate-btn-${teamIdOrId}`}
          >
            Deactivate workspace
          </MenuItem>
        </Menu>
      </Dropdown>
    );
  };

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="slack-workspaces-tab">
      <AdminPageHeader
        title="Slack workspaces"
        count={loading || loadError ? undefined : workspaces.length}
        description="Slack workspaces connected through OAuth. Deactivating one stops the bot from replying there."
        actions={
          <>
            <Button
              size="sm"
              startDecorator={<Add />}
              onClick={() => setCreateAppModalOpen(true)}
              data-testid="slack-create-app-btn"
            >
              Create Slack app
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<Refresh />}
              onClick={fetchWorkspaces}
              loading={refreshing}
              disabled={loading}
              data-testid="slack-workspaces-refresh-btn"
            >
              Refresh
            </Button>
            <ContextHelpButton helpId="admin/slack-workspaces" tooltipText="Slack workspaces help" />
          </>
        }
      />

      {loading ? (
        <LoadingState label="Loading Slack workspaces" />
      ) : (
        <Stack gap={1} sx={{ minWidth: 0 }}>
          <UpdatingBar active={refreshing} testId="slack-workspaces-updating" />
          <DataTable
            rows={workspaces}
            columns={columns}
            getRowId={workspace => workspace.id}
            label="Slack workspaces"
            error={loadError ?? undefined}
            onRetry={fetchWorkspaces}
            empty={
              <EmptyState
                title="No workspaces connected"
                description="A workspace appears here once someone installs the bot at /integrations/slack/install."
                action={
                  <Button
                    variant="outlined"
                    color="neutral"
                    startDecorator={<Add />}
                    onClick={() => setCreateAppModalOpen(true)}
                    data-testid="slack-workspaces-empty-create-btn"
                  >
                    Create Slack app
                  </Button>
                }
              />
            }
            rowActions={rowActions}
            rowTestId={workspace => `slack-workspace-row-${workspace.id}`}
            testId="slack-workspaces-table"
            // The fixed columns take 58.5rem, which leaves the workspace name 9.5rem.
            minWidth="68rem"
          />
        </Stack>
      )}

      <ActionDialog
        open={deactivateModalOpen}
        onClose={closeDeactivateDialog}
        title="Deactivate workspace"
        description={
          <>
            The bot stops replying in <strong>{selectedWorkspace?.name}</strong>. You can reconnect the workspace later
            by reinstalling it through OAuth.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.slackWorkspaceDeactivate}
        reasonAudited={false}
        confirmLabel="Deactivate workspace"
        tone="danger"
        pending={deactivating}
        onConfirm={handleDeactivateConfirm}
        data-testid="slack-workspace-deactivate-dialog"
        testIds={{ confirm: 'slack-workspace-deactivate-confirm-btn' }}
      />

      <AdminDialog
        open={exportModalOpen}
        onClose={() => {
          if (!exporting && (!asyncJob || asyncJob.status !== 'processing')) resetExportDialog();
        }}
        title="Export channel history"
        width={600}
        data-testid="slack-export-dialog"
      >
        <Stack gap={2}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Export complete channel history for <strong>{selectedWorkspace?.name}</strong>
          </Typography>

          <Alert color="neutral" startDecorator={<InfoOutlined />} data-testid="slack-export-bot-guidance-alert">
            <Box>
              <Typography level="body-sm">
                <strong>Requirement:</strong> The {selectedWorkspace?.slackBotName || 'Slack bot'} must be a member of
                the channel you want to export. In Slack, type{' '}
                <code>/invite @{selectedWorkspace?.slackBotName || 'Slack bot'}</code> in the channel to add it.
              </Typography>
              <Typography level="body-xs" sx={{ mt: 0.5 }}>
                For private channels, you must have permission to invite bots.
              </Typography>
            </Box>
          </Alert>

          <FormControl required>
            <FormLabel>Channel ID</FormLabel>
            <Stack direction="row" gap={1}>
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
                variant="outlined"
                color="neutral"
                onClick={checkChannelInfo}
                disabled={!exportChannelId || exporting || checkingChannel}
                loading={checkingChannel}
                data-testid="slack-export-check-channel-btn"
              >
                Check
              </Button>
            </Stack>
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'admin.inkMuted' }}>
              In Slack, right-click the channel, choose Copy link, and take the ID from the end of the URL.
            </Typography>
          </FormControl>

          {channelError && (
            <Alert color="danger" data-testid="slack-export-channel-error">
              {channelError}
            </Alert>
          )}

          {channelInfo && (
            <Alert color={channelInfo.warning ? 'warning' : 'neutral'} data-testid="slack-export-channel-info">
              <Stack gap={1} sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                  <Typography level="title-sm">#{channelInfo.name}</Typography>
                  {channelInfo.isPrivate && <StatusChip tone="neutral" label="Private" />}
                  {channelInfo.isArchived && <StatusChip tone="warn" label="Archived" />}
                </Stack>
                <Stack direction="row" gap={2} flexWrap="wrap">
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
                  <Typography level="body-xs">
                    First message: {new Date(parseFloat(channelInfo.oldestMessageTs) * 1000).toLocaleDateString()}
                  </Typography>
                )}
                {channelInfo.warning && <Typography level="body-xs">{channelInfo.warning}</Typography>}
              </Stack>
            </Alert>
          )}

          <FormControl>
            <FormLabel>Export format</FormLabel>
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
            <FormLabel>Date range</FormLabel>
            <Stack direction="row" sx={{ mb: 1, flexWrap: 'wrap', gap: 0.5 }}>
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
            <Stack direction="row" gap={2} flexWrap="wrap">
              <FormControl sx={{ flex: 1, minWidth: '10rem' }}>
                <FormLabel>Start date</FormLabel>
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
              <FormControl sx={{ flex: 1, minWidth: '10rem' }}>
                <FormLabel>End date</FormLabel>
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
                Exporting without date filters may timeout on large channels. Consider adding a date range for channels
                with many messages.
              </Typography>
            </Alert>
          )}

          <Stack gap={1}>
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

          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
            <Box>
              <Typography level="title-sm">Background export</Typography>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Process large channels in background (up to 15 minutes)
              </Typography>
            </Box>
            <Switch
              checked={useAsyncExport}
              onChange={e => setUseAsyncExport(e.target.checked)}
              disabled={exporting || jobRunning}
              data-testid="slack-export-async-toggle"
            />
          </Stack>

          {asyncJob && (
            <Alert
              color={asyncJob.status === 'completed' ? 'success' : asyncJob.status === 'failed' ? 'danger' : 'neutral'}
              data-testid="slack-export-job-status"
            >
              <Stack gap={1.5} sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
                  <Typography level="title-sm">
                    {asyncJob.status === 'completed' && 'Export complete'}
                    {asyncJob.status === 'failed' && 'Export failed'}
                    {asyncJob.status === 'cancelled' && 'Export cancelled'}
                    {asyncJob.status === 'processing' && 'Exporting...'}
                    {asyncJob.status === 'pending' && 'Starting...'}
                  </Typography>
                  {jobRunning && (
                    <Button
                      size="sm"
                      variant="outlined"
                      color="danger"
                      onClick={() => setCancelJobId(asyncJob.id)}
                      data-testid="slack-export-cancel-async-btn"
                    >
                      Cancel export
                    </Button>
                  )}
                </Stack>

                {jobRunning && (
                  <>
                    <LinearProgress determinate value={asyncJob.progress} />
                    <Typography level="body-xs">
                      {asyncJob.currentStep}
                      {asyncJob.processedMessages !== undefined && asyncJob.processedMessages > 0 && (
                        <>
                          {' \u2022 '}
                          {asyncJob.processedMessages.toLocaleString()} messages
                        </>
                      )}
                    </Typography>
                  </>
                )}

                {asyncJob.status === 'completed' && asyncJob.downloadUrl && (
                  <Stack gap={1} alignItems="flex-start">
                    <Typography level="body-xs">
                      {asyncJob.processedMessages?.toLocaleString()} messages exported
                      {asyncJob.fileSize && (
                        <>
                          {' \u2022 '}
                          {(asyncJob.fileSize / 1024).toFixed(1)} KB
                        </>
                      )}
                    </Typography>
                    <Button
                      startDecorator={<Download />}
                      component="a"
                      href={asyncJob.downloadUrl}
                      download
                      data-testid="slack-export-download-btn"
                    >
                      Download export
                    </Button>
                    <Typography level="body-xs">
                      Link expires:{' '}
                      {asyncJob.downloadExpiresAt ? new Date(asyncJob.downloadExpiresAt).toLocaleString() : 'in 1 hour'}
                    </Typography>
                  </Stack>
                )}

                {asyncJob.status === 'failed' && (
                  <Typography level="body-xs">{asyncJob.errorMessage || 'Unknown error occurred'}</Typography>
                )}
              </Stack>
            </Alert>
          )}

          {exporting && !useAsyncExport && (
            <Box>
              <LinearProgress />
              <Typography level="body-sm" sx={{ mt: 1, textAlign: 'center', color: 'admin.inkMuted' }}>
                Exporting channel... This may take a while for large channels.
              </Typography>
            </Box>
          )}
        </Stack>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={resetExportDialog}
            disabled={exporting || jobRunning}
            data-testid="slack-export-cancel-btn"
          >
            {jobFinished ? 'Close' : 'Cancel'}
          </Button>
          {(!asyncJob || asyncJob.status === 'cancelled' || asyncJob.status === 'failed') && (
            <Button
              onClick={handleExportConfirm}
              loading={exporting}
              disabled={!exportChannelId}
              data-testid="slack-export-confirm-btn"
            >
              {useAsyncExport ? 'Start export' : 'Export'}
            </Button>
          )}
        </DialogFooter>
      </AdminDialog>

      {/* Keyed to the job it was opened for, so a later job never reopens it. */}
      <ActionDialog
        open={jobRunning && cancelJobId === asyncJob?.id}
        onClose={() => setCancelJobId(null)}
        title="Cancel export"
        description="The background export stops now and its progress is lost. You can start a new export afterwards."
        reasonPresets={ADMIN_REASON_PRESETS.slackExportCancel}
        reasonAudited={false}
        confirmLabel="Cancel export"
        tone="danger"
        onConfirm={async () => {
          if (await cancelAsyncExport()) setCancelJobId(null);
        }}
        data-testid="slack-export-cancel-job-dialog"
      />

      <AdminDialog
        open={updateModalOpen}
        onClose={() => {
          if (!updating) closeUpdateDialog();
        }}
        title="Update manifest"
        width={560}
        role="alertdialog"
        data-testid="manifest-update-dialog"
      >
        <Stack gap={2}>
          <Typography level="body-md">
            Update the manifest for <strong>{updateModalWorkspace?.name || updateModalWorkspace?.slackAppId}</strong>?
          </Typography>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            This will update scopes, events, commands, interactivity settings, and workflow steps. Your app&apos;s name,
            description, and color will not be changed. Workflows that already use a workflow step whose inputs changed
            need that step re-added in Workflow Builder.
          </Typography>
          {updateDiffs && (
            <Box
              data-testid="manifest-update-diff"
              sx={{
                maxHeight: '12.5rem',
                overflow: 'auto',
                bgcolor: 'admin.surfaceSubtle',
                border: '1px solid',
                borderColor: 'admin.border',
                borderRadius: 'sm',
                p: 1.5,
              }}
            >
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Changes to apply
              </Typography>
              {updateDiffs.map((diff: ManifestDifference, i: number) => (
                <Box key={i} sx={{ mb: 1 }}>
                  <Typography level="body-xs" sx={{ fontFamily: 'code', color: 'admin.ink' }}>
                    {diff.field}
                  </Typography>
                  <Typography level="body-xs" sx={{ fontFamily: 'code', color: 'admin.status.bad.foreground' }}>
                    - {JSON.stringify(diff.actual)}
                  </Typography>
                  <Typography level="body-xs" sx={{ fontFamily: 'code', color: 'admin.status.good.foreground' }}>
                    + {JSON.stringify(diff.expected)}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Stack>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={closeUpdateDialog}
            disabled={updating}
            data-testid="manifest-update-cancel-btn"
          >
            Cancel
          </Button>
          <Button onClick={handleUpdateManifest} loading={updating} data-testid="manifest-update-confirm-btn">
            Update manifest
          </Button>
        </DialogFooter>
      </AdminDialog>

      <AdminDialog
        open={reconnectModalOpen}
        onClose={() => {
          if (!reconnecting) closeReconnectDialog();
        }}
        title="Reconnect configuration token"
        width={480}
        data-testid="reconnect-dialog"
      >
        <Stack gap={2}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Provide a Slack app configuration token to enable manifest management for{' '}
            <strong>{reconnectModalWorkspace?.name || reconnectModalWorkspace?.slackAppId}</strong>.
          </Typography>
          <Alert color="neutral" startDecorator={<InfoOutlined />}>
            <Typography level="body-xs">
              Go to{' '}
              <Link href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
                api.slack.com/apps
              </Link>
              , scroll below the app list, and find <strong>Your App Configuration Tokens</strong>. Click{' '}
              <strong>Generate Token</strong> next to your workspace. Note: tokens expire after 12 hours.
            </Typography>
          </Alert>
          {reconnectError && (
            <Alert color="danger" size="sm" data-testid="reconnect-error-alert">
              {reconnectError}
            </Alert>
          )}
          <FormControl required>
            <FormLabel>Configuration token</FormLabel>
            <Input
              type="password"
              value={reconnectToken}
              onChange={e => setReconnectToken(e.target.value)}
              placeholder="xoxe.xoxp-..."
              disabled={reconnecting}
              slotProps={{ input: { 'data-testid': 'reconnect-token-input' } }}
            />
          </FormControl>
        </Stack>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={closeReconnectDialog}
            disabled={reconnecting}
            data-testid="reconnect-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            onClick={handleReconnect}
            loading={reconnecting}
            disabled={!reconnectToken.trim()}
            data-testid="reconnect-confirm-btn"
          >
            Reconnect
          </Button>
        </DialogFooter>
      </AdminDialog>

      <CreateSlackAppModal
        open={createAppModalOpen}
        onClose={() => setCreateAppModalOpen(false)}
        onSuccess={() => {
          toast.success('Slack app created successfully!');
          fetchWorkspaces(); // Refresh workspaces list to show the newly created app
        }}
      />
    </Stack>
  );
};

export default SlackWorkspacesTab;
