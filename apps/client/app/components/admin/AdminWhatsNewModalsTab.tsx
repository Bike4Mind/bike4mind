import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  ModalOverflow,
  Option,
  Select,
  Sheet,
  Stack,
  Switch,
  Table,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import ErrorBoundary from '@client/app/components/common/ErrorBoundary';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import SyncIcon from '@mui/icons-material/Sync';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import InfoIcon from '@mui/icons-material/Info';
import { FieldTooltip } from '@client/app/components/help';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ErrorIcon from '@mui/icons-material/Error';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CodeIcon from '@mui/icons-material/Code';
import WarningIcon from '@mui/icons-material/Warning';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AnnouncementIcon from '@mui/icons-material/Announcement';
import SaveIcon from '@mui/icons-material/Save';
import { AdminWhatsNewConfiguration } from './AdminWhatsNewConfiguration';
import { useGetSettingsValue, useUpdateSettings } from '@client/app/hooks/data/settings';
import { IModalDocument } from '@bike4mind/common';
import {
  useGetWhatsNewModals,
  useGetAvailableWhatsNewModals,
  useGetWhatsNewSyncConfig,
  useUpdateWhatsNewSyncConfig,
  useImportWhatsNewModals,
  useSyncLatestWhatsNewModal,
  useDeleteWhatsNewModal,
  useToggleWhatsNewModal,
  useCreateWhatsNewModal,
  useUpdateWhatsNewModal,
  useGetHighlightsConfig,
  useUpdateHighlightsConfig,
  useGenerateHighlights,
  useGetGenerationStatus,
  useBackfillWhatsNew,
  useGetRawModalVariants,
  useUpdateWhatsNewModalVariants,
  type AvailableModalEntry,
  type GenerationStatusResponse,
} from '@client/app/hooks/data/whatsNewModals';

// Variant registry for client use (mirrors AUDIENCE_VARIANTS in @bike4mind/services but
// defined locally to avoid pulling the server-only services package into the client bundle).
const AUDIENCE_VARIANTS_CLIENT = [
  { key: 'internal', audienceType: 'internal', label: 'Internal' },
  { key: 'customer', audienceType: 'customer', label: 'Customer' },
] as const;
type ModalAudienceKey = (typeof AUDIENCE_VARIANTS_CLIENT)[number]['key'];

type VariantFieldsEdit = { title: string; subtitle: string; description: string };

const EMPTY_VARIANT: VariantFieldsEdit = { title: '', subtitle: '', description: '' };

function toEditableVariants(
  variants?: Partial<
    Record<string, { title?: string | null; subtitle?: string | null; description?: string | null }>
  > | null
): Record<ModalAudienceKey, VariantFieldsEdit> {
  const out = {} as Record<ModalAudienceKey, VariantFieldsEdit>;
  for (const v of AUDIENCE_VARIANTS_CLIENT) {
    const existing = variants?.[v.key];
    out[v.key] = existing
      ? { title: existing.title ?? '', subtitle: existing.subtitle ?? '', description: existing.description ?? '' }
      : { ...EMPTY_VARIANT };
  }
  return out;
}
import {
  formatDateISO,
  toDateInputValue,
  getLocalDate,
  formatDisplayDate,
  parseSubtitleToEditFields,
} from '@client/app/utils/dateUtils';
import PaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import {
  partitionModals,
  getModalPriorityStatus,
  getStatusChipColor,
  getStatusLabel,
} from './AdminWhatsNewModalsTab.utils';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import {
  HIGHLIGHTS_TEMPLATE_VARIABLES,
  getDefaultHighlightsTemplate,
} from '@server/queueHandlers/whatsNewHighlights.prompt';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

// Layout constants
const MODAL_MAX_WIDTH = 600;
const MODAL_MIN_WIDTH = 400;
const PREVIEW_MAX_WIDTH = 700;
const DESCRIPTION_MIN_ROWS = 6;
const PREVIEW_MAX_HEIGHT = 400;
const MAX_EXPIRY_YEARS = 2; // Maximum years into the future for expiry date

/**
 * Get max date for expiry picker (2 years from now)
 */
function getMaxExpiryDate(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + MAX_EXPIRY_YEARS);
  return date.toISOString().split('T')[0];
}

/**
 * Format a time distance in a human-readable format (e.g., "5 minutes ago")
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) return 'less than a minute';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'}`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'}`;
  return `${diffDays} day${diffDays === 1 ? '' : 's'}`;
}

interface ExpiryStatus {
  label: string;
  color: 'danger' | 'warning' | 'success' | 'neutral';
  daysRemaining: number | null;
}

/**
 * Calculate expiry status for a modal based on its endDate
 */
function getExpiryStatus(endDate: string | null | undefined): ExpiryStatus {
  if (!endDate) {
    return { label: 'No expiry', color: 'neutral', daysRemaining: null };
  }
  const now = new Date();
  const end = new Date(endDate);
  const diffMs = end.getTime() - now.getTime();
  const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (daysRemaining <= 0) {
    return { label: 'Expired', color: 'danger', daysRemaining };
  }
  if (daysRemaining <= 7) {
    return { label: `${daysRemaining}d left`, color: 'warning', daysRemaining };
  }
  return { label: `${daysRemaining}d left`, color: 'success', daysRemaining };
}

/**
 * Props for the ModalTableRow component
 */
interface ModalTableRowProps {
  modal: IModalDocument;
  onView: (modal: IModalDocument) => void;
  onEdit: (modal: IModalDocument) => void;
  onToggle: (modal: IModalDocument) => void;
  onDelete: (modal: IModalDocument) => void;
  isTogglePending: boolean;
  isDeletePending: boolean;
  testIdPrefix: string;
}

function ModalActions({
  modal,
  onView,
  onEdit,
  onToggle,
  onDelete,
  isTogglePending,
  isDeletePending,
  testIdPrefix,
}: ModalTableRowProps) {
  return (
    <Stack direction="row" spacing={0.5}>
      <Tooltip title="View">
        <IconButton
          size="sm"
          variant="plain"
          aria-label="View modal"
          onClick={() => onView(modal)}
          data-testid={`${testIdPrefix}-view-btn`}
        >
          <VisibilityIcon />
        </IconButton>
      </Tooltip>
      <Tooltip title="Edit">
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Edit modal"
          onClick={() => onEdit(modal)}
          data-testid={`${testIdPrefix}-edit-btn`}
        >
          <EditIcon />
        </IconButton>
      </Tooltip>
      <Tooltip title={modal.enabled ? 'Disable' : 'Enable'}>
        <IconButton
          size="sm"
          variant="plain"
          color={modal.enabled ? 'success' : 'neutral'}
          aria-label={modal.enabled ? 'Disable modal' : 'Enable modal'}
          onClick={() => onToggle(modal)}
          disabled={isTogglePending || !modal._id}
          data-testid={`${testIdPrefix}-toggle-btn`}
        >
          {isTogglePending ? <CircularProgress size="sm" /> : <PowerSettingsNewIcon />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Delete">
        <IconButton
          size="sm"
          variant="plain"
          color="danger"
          aria-label="Delete modal"
          onClick={() => onDelete(modal)}
          disabled={isDeletePending}
          data-testid={`${testIdPrefix}-delete-btn`}
        >
          {isDeletePending ? <CircularProgress size="sm" /> : <DeleteIcon />}
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

function ModalMobileCard({
  modal,
  onView,
  onEdit,
  onToggle,
  onDelete,
  isTogglePending,
  isDeletePending,
  testIdPrefix,
}: ModalTableRowProps) {
  const priorityStatus = getModalPriorityStatus(modal);
  const expiryStatus = getExpiryStatus(modal.endDate);

  return (
    <Card variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Typography level="title-sm" fontWeight="lg" sx={{ flex: 1, mr: 1 }}>
            {modal.title}
          </Typography>
          <Tooltip
            title={`Enabled: ${modal.enabled ? 'Yes' : 'No'}${modal.endDate ? ` | Expires: ${formatDateISO(modal.endDate)}` : ''}`}
          >
            <Chip
              size="sm"
              variant="outlined"
              color={getStatusChipColor(priorityStatus)}
              startDecorator={priorityStatus === 'active' ? <CheckCircleIcon /> : <PendingIcon />}
            >
              {getStatusLabel(priorityStatus)}
            </Chip>
          </Tooltip>
        </Stack>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
            <Typography level="body-xs" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {modal.generationMetadata?.generatedDate || formatDateISO(modal.createdAt)}
            </Typography>
            <Chip size="sm" variant="outlined" color={expiryStatus.color}>
              {expiryStatus.label}
            </Chip>
            <Chip
              size="sm"
              variant="outlined"
              color={modal.generationMetadata?.importedFrom === 'production' ? 'primary' : 'neutral'}
            >
              {modal.generationMetadata?.importedFrom || 'self'}
            </Chip>
          </Stack>
          <Box sx={{ flexShrink: 0 }}>
            <ModalActions
              modal={modal}
              onView={onView}
              onEdit={onEdit}
              onToggle={onToggle}
              onDelete={onDelete}
              isTogglePending={isTogglePending}
              isDeletePending={isDeletePending}
              testIdPrefix={testIdPrefix}
            />
          </Box>
        </Stack>
      </Stack>
    </Card>
  );
}

function ModalTableRow({
  modal,
  onView,
  onEdit,
  onToggle,
  onDelete,
  isTogglePending,
  isDeletePending,
  testIdPrefix,
}: ModalTableRowProps) {
  const priorityStatus = getModalPriorityStatus(modal);
  const expiryStatus = getExpiryStatus(modal.endDate);

  return (
    <tr key={modal._id?.toString() ?? 'unknown'}>
      <td>
        <Typography level="body-sm" noWrap sx={{ maxWidth: 300 }}>
          {modal.title}
        </Typography>
      </td>
      <td>
        <Typography level="body-xs">
          {modal.generationMetadata?.generatedDate || formatDateISO(modal.createdAt)}
        </Typography>
      </td>
      <td>
        <Tooltip
          title={`Enabled: ${modal.enabled ? 'Yes' : 'No'}${modal.endDate ? ` | Expires: ${formatDateISO(modal.endDate)}` : ''}`}
        >
          <Chip
            size="sm"
            variant="outlined"
            color={getStatusChipColor(priorityStatus)}
            startDecorator={priorityStatus === 'active' ? <CheckCircleIcon /> : <PendingIcon />}
          >
            {getStatusLabel(priorityStatus)}
          </Chip>
        </Tooltip>
      </td>
      <td>
        <Chip size="sm" variant="outlined" color={expiryStatus.color}>
          {expiryStatus.label}
        </Chip>
      </td>
      <td>
        <Chip
          size="sm"
          variant="outlined"
          color={modal.generationMetadata?.importedFrom === 'production' ? 'primary' : 'neutral'}
        >
          {modal.generationMetadata?.importedFrom || 'self'}
        </Chip>
      </td>
      <td>
        <ModalActions
          modal={modal}
          onView={onView}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          isTogglePending={isTogglePending}
          isDeletePending={isDeletePending}
          testIdPrefix={testIdPrefix}
        />
      </td>
    </tr>
  );
}

/**
 * Error fallback component for the What's New admin tab.
 */
function WhatsNewErrorFallback() {
  return (
    <Alert variant="outlined" color="danger" sx={{ m: 2 }}>
      <Typography level="title-md">Something went wrong</Typography>
      <Typography level="body-sm">
        An error occurred while loading the What&apos;s New management panel. Please try refreshing the page.
      </Typography>
    </Alert>
  );
}

/**
 * Admin tab for managing What's New modals.
 * Provides:
 * - Sync configuration (auto-sync toggle)
 * - Active modals section (local What's New modals)
 * - Available for sync section (modals from production S3)
 */
export default function AdminWhatsNewModalsTab() {
  // Get stage and source environment status from sync config endpoint
  const { data: configData } = useGetWhatsNewSyncConfig();
  const stage = configData?.stage || 'unknown';
  // isSourceEnvironment is true when ENABLE_WHATS_NEW_DISTRIBUTION=true (main production only)
  // This distinguishes main production from fork "production" stages
  const isSourceEnvironment = configData?.isSourceEnvironment ?? false;
  // isForkProduction is true when stage=production but NOT source environment
  // Fork production defaults to auto-sync OFF (opt-in)
  const isForkProduction = configData?.isForkProduction ?? false;
  // distributionUrlConfigured is true when WHATS_NEW_DISTRIBUTION_URL is set
  // Sync won't work without this URL configured
  const distributionUrlConfigured = configData?.distributionUrlConfigured ?? false;

  // Determine chip color based on environment type
  const getChipColor = () => {
    if (isSourceEnvironment) return 'danger';
    if (isForkProduction) return 'warning';
    return 'success';
  };

  // Get environment label suffix
  const getEnvironmentSuffix = () => {
    if (isSourceEnvironment) return ' (Source)';
    if (isForkProduction) return ' (Fork)';
    return '';
  };

  return (
    <ErrorBoundary fallback={<WhatsNewErrorFallback />}>
      <Box sx={{ p: 2 }}>
        <Stack spacing={{ xs: 1.5, sm: 3 }}>
          {/* Header */}
          <Box>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography level="h3">What&apos;s New Modals</Typography>
              <ContextHelpButton helpId="admin/whats-new" tooltipText="What's New Help" />
            </Stack>
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              Manage What&apos;s New modals for your environment. These modals are automatically generated from
              production releases.
            </Typography>
            <Chip size="sm" variant="outlined" color={getChipColor()} sx={{ mt: 1 }}>
              Environment: {stage}
              {getEnvironmentSuffix()}
            </Chip>
          </Box>

          {/* Source environment alert */}
          {isSourceEnvironment && (
            <Alert variant="outlined" color="warning" startDecorator={<InfoIcon />}>
              What&apos;s New sync is disabled in this environment. This is the source environment that generates and
              distributes modals to other environments.
            </Alert>
          )}

          {/* Sync Configuration - only for non-source environments */}
          {!isSourceEnvironment && (
            <>
              {/* Info alert for fork production environments */}
              {isForkProduction && distributionUrlConfigured && (
                <Alert variant="outlined" color="neutral" startDecorator={<InfoIcon />}>
                  This is a fork production environment. Auto-sync is disabled by default. Enable it below if you want
                  to automatically receive What&apos;s New modals from the main production environment.
                </Alert>
              )}

              {/* Sync Configuration - always visible so users can set the URL */}
              <SyncConfigCard />
            </>
          )}

          {/* What's New Modals - ALWAYS visible (primary content) */}
          <ActiveModalsCard hideCreate={isSourceEnvironment} isSourceEnvironment={isSourceEnvironment} />

          {/* Available for Sync - only for non-source environments (secondary action) */}
          {!isSourceEnvironment && distributionUrlConfigured && <AvailableModalsCard />}

          {/* Daily Modal Generation - health, backfill, and config in one section */}
          {(isSourceEnvironment || stage === 'dev' || stage.startsWith('pr')) && <DailyGenerationCard />}

          {/* Weekly Highlights to Slack - only for main environments (production, dev, or PR previews), not forks */}
          {(isSourceEnvironment || stage === 'dev' || stage.startsWith('pr')) && <WeeklyHighlightsCard />}
        </Stack>
      </Box>
    </ErrorBoundary>
  );
}

/**
 * Check if a hostname matches an allowed domain pattern.
 * Supports both exact domain match and subdomain match.
 * This prevents bypass attacks like 'evilcloudfront.net'.
 */
function isAllowedHostname(hostname: string, allowedDomain: string): boolean {
  const baseDomain = allowedDomain.slice(1); // Remove leading dot
  // Exact match or subdomain match (with the dot ensuring proper subdomain boundary)
  return hostname === baseDomain || hostname.endsWith(allowedDomain);
}

/**
 * Client-side URL validation (matches server-side validateDistributionUrl)
 */
function validateUrlClient(url: string): { valid: boolean; error?: string } {
  if (!url) return { valid: true }; // Empty is allowed (clears override)
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL must use HTTPS' };
    }
    // Check CloudFront pattern
    if (isAllowedHostname(parsed.hostname, '.cloudfront.net')) {
      return { valid: true };
    }
    // Check the deployment's own custom domain (routes through CloudFront). Sourced from
    // NEXT_PUBLIC_SERVER_DOMAIN with no brand fallback.
    const serverDomain = process.env.NEXT_PUBLIC_SERVER_DOMAIN;
    if (serverDomain && isAllowedHostname(parsed.hostname, `.${serverDomain}`)) {
      return { valid: true };
    }
    // Check S3 patterns (global or regional)
    if (
      isAllowedHostname(parsed.hostname, '.s3.amazonaws.com') ||
      parsed.hostname.match(/\.s3\.[a-z0-9-]+\.amazonaws\.com$/)
    ) {
      return { valid: true };
    }
    return {
      valid: false,
      error: 'URL must be a CloudFront, S3, or the configured deployment domain',
    };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Sync configuration card with auto-sync toggle, distribution URL override, and manual sync button.
 */
function SyncConfigCard() {
  const { data: configData, isLoading: configLoading, refetch: refetchConfig } = useGetWhatsNewSyncConfig();
  const updateConfig = useUpdateWhatsNewSyncConfig();
  const syncLatest = useSyncLatestWhatsNewModal();

  const autoSyncEnabled = configData?.config?.autoSyncEnabled ?? true;

  // URL override state
  const [urlOverride, setUrlOverride] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlSuccess, setUrlSuccess] = useState<string | null>(null);
  const [urlDirty, setUrlDirty] = useState(false);

  // Initialize URL from config when data loads
  useEffect(() => {
    if (configData?.config?.distributionUrlOverride !== undefined) {
      setUrlOverride(configData.config.distributionUrlOverride || '');
      setUrlDirty(false);
    }
  }, [configData?.config?.distributionUrlOverride]);

  // Auto-clear success message after 3 seconds
  useEffect(() => {
    if (urlSuccess) {
      const timer = setTimeout(() => setUrlSuccess(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [urlSuccess]);

  const handleUrlChange = (value: string) => {
    setUrlOverride(value);
    setUrlError(null);
    setUrlSuccess(null);
    setUrlDirty(true);
  };

  const handleSaveUrl = () => {
    // Client-side validation
    const validation = validateUrlClient(urlOverride);
    if (!validation.valid) {
      setUrlError(validation.error || 'Invalid URL');
      return;
    }

    setUrlError(null);
    setUrlSuccess(null);
    updateConfig.mutate(
      {
        ...configData?.config,
        distributionUrlOverride: urlOverride || null,
      },
      {
        onSuccess: () => {
          setUrlDirty(false);
          setUrlSuccess('URL saved successfully');
          refetchConfig();
        },
        onError: error => {
          setUrlError(error instanceof Error ? error.message : 'Failed to save URL');
        },
      }
    );
  };

  const handleClearUrl = () => {
    // Immediately clear the input field
    setUrlOverride('');
    setUrlError(null);
    setUrlSuccess(null);
    setUrlDirty(false);
    updateConfig.mutate(
      {
        ...configData?.config,
        distributionUrlOverride: null,
      },
      {
        onSuccess: () => {
          setUrlSuccess('URL cleared');
          refetchConfig();
        },
      }
    );
  };

  return (
    <Card variant="outlined">
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <SyncIcon color="primary" />
          <Typography level="title-lg">Sync Configuration</Typography>
        </Stack>

        {/* Distribution URL Override */}
        <FormControl error={!!urlError} sx={{ mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <FormLabel sx={{ m: 0 }}>Distribution URL</FormLabel>
            <FieldTooltip
              ariaLabel="Help: Distribution URL"
              content="Override the default SST secret URL. Must be a CloudFront or S3 HTTPS URL. Leave empty to use SST secret."
            />
          </Box>
          <Stack direction="row" spacing={1}>
            <Input
              placeholder="https://abc123.cloudfront.net/whats-new"
              value={urlOverride}
              onChange={e => handleUrlChange(e.target.value)}
              disabled={configLoading || updateConfig.isPending}
              sx={{ flex: 1 }}
              data-testid="whats-new-distribution-url-input"
            />
            <Button
              variant="soft"
              onClick={handleSaveUrl}
              disabled={updateConfig.isPending || !urlDirty}
              loading={updateConfig.isPending}
              data-testid="whats-new-distribution-url-save-btn"
            >
              Save
            </Button>
            {(configData?.config?.distributionUrlOverride || urlOverride) && (
              <Button
                variant="plain"
                color="neutral"
                onClick={handleClearUrl}
                disabled={updateConfig.isPending || !urlOverride}
                data-testid="whats-new-distribution-url-clear-btn"
              >
                Clear
              </Button>
            )}
          </Stack>
          {urlError && (
            <Typography level="body-xs" color="danger" sx={{ mt: 0.5 }}>
              {urlError}
            </Typography>
          )}
          {urlSuccess && (
            <Typography level="body-xs" color="success" sx={{ mt: 0.5 }}>
              {urlSuccess}
            </Typography>
          )}
          <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
            {configData?.distributionUrlConfigured ? (
              <>Currently using: {configData.distributionUrlSource === 'admin' ? 'Admin override' : 'SST secret'}</>
            ) : (
              <>Not configured. Enter a URL above or configure the WHATS_NEW_DISTRIBUTION_URL SST secret.</>
            )}
          </Typography>
        </FormControl>

        <Divider sx={{ my: 2 }} />

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1.5, sm: 3 }}
          alignItems={{ xs: 'stretch', sm: 'center' }}
        >
          {/* Auto-sync toggle */}
          <Stack direction="row" spacing={1} alignItems="center">
            <Switch
              checked={autoSyncEnabled}
              onChange={e => updateConfig.mutate({ ...configData?.config, autoSyncEnabled: e.target.checked })}
              disabled={!configData?.distributionUrlConfigured || configLoading || updateConfig.isPending}
            />
            <Typography
              level="body-sm"
              sx={{ color: !configData?.distributionUrlConfigured ? 'text.tertiary' : undefined }}
            >
              Auto-sync enabled
              <Tooltip title="When enabled, the cron job will automatically import the latest modal from production daily.">
                <InfoIcon
                  sx={{ ml: 0.5, fontSize: 14, color: 'text.tertiary' }}
                  aria-label="Auto-sync information"
                  role="img"
                />
              </Tooltip>
            </Typography>
          </Stack>

          <Divider orientation="vertical" sx={{ display: { xs: 'none', sm: 'block' } }} />

          {/* Manual sync buttons */}
          <Stack direction="row" spacing={1} sx={{ flex: 1 }}>
            <Button
              variant="soft"
              color="primary"
              startDecorator={syncLatest.isPending ? <CircularProgress size="sm" /> : <SyncIcon />}
              onClick={() => syncLatest.mutate()}
              disabled={!configData?.distributionUrlConfigured || syncLatest.isPending}
              data-testid="whats-new-sync-latest-btn"
              sx={{ flex: 1 }}
            >
              Sync Latest
            </Button>
            <IconButton
              variant="plain"
              size="sm"
              onClick={() => refetchConfig()}
              disabled={configLoading}
              aria-label="Refresh sync configuration"
              data-testid="whats-new-sync-refresh-btn"
            >
              <RefreshIcon />
            </IconButton>
          </Stack>
        </Stack>

        {configData?.config?.lastSyncAt && (
          <Typography level="body-xs" sx={{ mt: 1, color: 'text.tertiary' }}>
            Last sync: {formatTimeAgo(new Date(configData.config.lastSyncAt))} ago
            {configData.config.lastSyncResult && ` (${configData.config.lastSyncResult})`}
          </Typography>
        )}
      </Box>
    </Card>
  );
}

interface ActiveModalsCardProps {
  /** Hide the Create Modal button (used in source environment where modals are auto-generated) */
  hideCreate?: boolean;
  /** Whether this is the source environment (production) - affects empty state messaging */
  isSourceEnvironment?: boolean;
}

/**
 * Active modals section showing local What's New modals.
 */
function ActiveModalsCard({ hideCreate = false, isSourceEnvironment = false }: ActiveModalsCardProps) {
  const isMobile = useIsMobile();
  const { data: modals, isLoading, refetch } = useGetWhatsNewModals();
  const deleteModal = useDeleteWhatsNewModal();
  const toggleModal = useToggleWhatsNewModal();
  const createModal = useCreateWhatsNewModal();
  const updateModal = useUpdateWhatsNewModal();
  const updateVariants = useUpdateWhatsNewModalVariants();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [previewModal, setPreviewModal] = useState<IModalDocument | null>(null);
  const [previewVariantTab, setPreviewVariantTab] = useState<ModalAudienceKey>(AUDIENCE_VARIANTS_CLIENT[0].key);
  const [editModal, setEditModal] = useState<IModalDocument | null>(null);
  const [editVariantTab, setEditVariantTab] = useState<ModalAudienceKey>(AUDIENCE_VARIANTS_CLIENT[0].key);
  const [editVariantData, setEditVariantData] =
    useState<Record<ModalAudienceKey, VariantFieldsEdit>>(toEditableVariants());
  const [editEndDate, setEditEndDate] = useState('');
  const [modalToDelete, setDeleteConfirmModal] = useState<IModalDocument | null>(null);
  const [newModalData, setNewModalData] = useState({
    title: '',
    displayDate: '',
    subtitle: '',
    description: '',
    endDate: '',
  });
  const [editModalData, setEditModalData] = useState({
    title: '',
    displayDate: '',
    subtitle: '',
    description: '',
    endDate: '',
  });

  // Fetch raw variants (unstripped) for whichever modal is open in view/edit.
  const rawVariantsModalId = previewModal?._id ?? editModal?._id ?? null;
  const { data: rawModal, isLoading: rawModalLoading } = useGetRawModalVariants(
    typeof rawVariantsModalId === 'string' ? rawVariantsModalId : null
  );

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);

  // Archived section expanded state
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  // Archived pagination state
  const [archivedPage, setArchivedPage] = useState(1);
  const [archivedItemsPerPage, setArchivedItemsPerPage] = useState(10);

  // Partition modals into active and archived
  const { active: activeModals, archived: archivedModals } = useMemo(() => partitionModals(modals || []), [modals]);

  // Sort active modals by creation date (newest first)
  const sortedActiveModals = useMemo(
    () => [...activeModals].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()),
    [activeModals]
  );

  // Sort archived modals by creation date (newest first)
  const sortedArchivedModals = useMemo(
    () =>
      [...archivedModals].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()),
    [archivedModals]
  );

  // Calculate archived pagination
  const archivedTotalPages = Math.ceil(sortedArchivedModals.length / archivedItemsPerPage);
  const archivedStartIndex = (archivedPage - 1) * archivedItemsPerPage;
  const archivedEndIndex = archivedStartIndex + archivedItemsPerPage;

  // Paginated archived modals
  const paginatedArchivedModals = useMemo(
    () => sortedArchivedModals.slice(archivedStartIndex, archivedEndIndex),
    [sortedArchivedModals, archivedStartIndex, archivedEndIndex]
  );

  // Calculate pagination
  const totalPages = Math.ceil(sortedActiveModals.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;

  // Paginated active modals
  const paginatedActiveModals = useMemo(
    () => sortedActiveModals.slice(startIndex, endIndex),
    [sortedActiveModals, startIndex, endIndex]
  );

  // Reset preview tab when switching to a different preview modal.
  useEffect(() => {
    if (previewModal) setPreviewVariantTab(AUDIENCE_VARIANTS_CLIENT[0].key);
  }, [previewModal?._id]);

  // Populate variant edit form once raw modal data arrives (rawModal fetched async after editModal is set).
  useEffect(() => {
    if (editModal && rawModal && rawModal._id === editModal._id) {
      setEditVariantData(toEditableVariants(rawModal.variants));
    }
  }, [rawModal, editModal]);

  // Reset to page 1 when total pages decrease below current page
  useEffect(() => {
    if (currentPage > 1 && currentPage > totalPages) {
      setCurrentPage(1);
    }
  }, [totalPages, currentPage]);

  // Memoized handlers for pagination
  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const handleItemsPerPageChange = useCallback((items: number) => {
    setItemsPerPage(items);
    setCurrentPage(1);
  }, []);

  // Reset archived page to 1 when total pages decrease below current page
  useEffect(() => {
    if (archivedPage > 1 && archivedPage > archivedTotalPages) {
      setArchivedPage(1);
    }
  }, [archivedTotalPages, archivedPage]);

  // Memoized handlers for archived pagination
  const handleArchivedPageChange = useCallback((page: number) => {
    setArchivedPage(page);
  }, []);

  const handleArchivedItemsPerPageChange = useCallback((items: number) => {
    setArchivedItemsPerPage(items);
    setArchivedPage(1);
  }, []);

  // Handler for toggling modal enabled/disabled state
  const handleToggleModal = useCallback(
    (modal: IModalDocument) => {
      if (!modal._id) return;
      toggleModal.mutate({
        modalId: modal._id.toString(),
        enabled: !modal.enabled,
      });
    },
    [toggleModal]
  );

  const handleCreateModal = () => {
    if (!newModalData.title.trim() || !newModalData.description.trim()) return;
    const formattedDate = newModalData.displayDate ? formatDisplayDate(newModalData.displayDate) : '';
    const subtitle =
      formattedDate && newModalData.subtitle
        ? `${formattedDate} · ${newModalData.subtitle}`
        : formattedDate || newModalData.subtitle;
    createModal.mutate(
      {
        title: newModalData.title,
        subtitle,
        description: newModalData.description,
        endDate: newModalData.endDate || undefined,
      },
      {
        onSuccess: () => {
          setShowCreateDialog(false);
          setNewModalData({ title: '', displayDate: '', subtitle: '', description: '', endDate: '' });
          refetch();
        },
      }
    );
  };

  const handleOpenEditDialog = (modal: IModalDocument) => {
    setEditModal(modal);
    setEditVariantTab(AUDIENCE_VARIANTS_CLIENT[0].key);
    setEditVariantData(toEditableVariants()); // pre-populate from rawModal via useEffect below
    setEditEndDate(toDateInputValue(modal.endDate));
    // Legacy flat-field edit state (used only for non-variant modals)
    const { displayDateInput, subtitleText } = parseSubtitleToEditFields(modal.subtitle);
    setEditModalData({
      title: modal.title || '',
      displayDate: displayDateInput,
      subtitle: subtitleText,
      description: modal.description || '',
      endDate: toDateInputValue(modal.endDate),
    });
  };

  const isVariantModal = !!(rawModal?.variants && Object.keys(rawModal.variants).length > 0);

  const handleEditModal = () => {
    if (!editModal?._id) return;
    const modalId = editModal._id.toString();

    if (isVariantModal) {
      // Variant-aware modal: save via the admin variants endpoint.
      // Only persist variants that have a title - empty title drops that audience slice.
      const variants = AUDIENCE_VARIANTS_CLIENT.reduce<
        Partial<Record<string, { title: string; subtitle: string; description: string }>>
      >((acc, v) => {
        const content = editVariantData[v.key];
        if (content.title.trim()) {
          acc[v.key] = {
            title: content.title.trim(),
            subtitle: content.subtitle.trim(),
            description: content.description,
          };
        }
        return acc;
      }, {});
      if (!Object.keys(variants).length) return; // at least one variant required
      updateVariants.mutate(
        { modalId, variants },
        {
          onSuccess: () => {
            if (editEndDate !== toDateInputValue(editModal.endDate)) {
              updateModal.mutate({
                modalId,
                updates: { endDate: editEndDate ? new Date(editEndDate).toISOString() : undefined },
              });
            }
            setEditModal(null);
          },
        }
      );
    } else {
      // Legacy flat-field modal: use existing update path.
      if (!editModalData.title.trim() || !editModalData.description.trim()) return;
      const formattedDate = editModalData.displayDate ? formatDisplayDate(editModalData.displayDate) : '';
      const subtitle =
        formattedDate && editModalData.subtitle
          ? `${formattedDate} · ${editModalData.subtitle}`
          : formattedDate || editModalData.subtitle;
      updateModal.mutate(
        {
          modalId,
          updates: {
            title: editModalData.title,
            subtitle,
            description: editModalData.description,
            endDate: editModalData.endDate ? new Date(editModalData.endDate).toISOString() : undefined,
          },
        },
        {
          onSuccess: () => {
            setEditModal(null);
            setEditModalData({ title: '', displayDate: '', subtitle: '', description: '', endDate: '' });
            refetch();
          },
        }
      );
    }
  };

  return (
    <Card variant="outlined">
      <Box>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          gap={1}
          sx={{ mb: 2 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <AnnouncementIcon color="primary" />
            <Typography level="title-lg">What&apos;s New Modals</Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            {!hideCreate && (
              <Button
                variant="soft"
                color="primary"
                size="sm"
                startDecorator={<AddIcon />}
                onClick={() => setShowCreateDialog(true)}
                data-testid="whats-new-create-btn"
                sx={{ flex: { xs: 1, sm: 'unset' } }}
              >
                Create Modal
              </Button>
            )}
            <IconButton
              variant="plain"
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading}
              aria-label="Refresh modals"
              data-testid="whats-new-refresh-btn"
            >
              <RefreshIcon />
            </IconButton>
          </Stack>
        </Stack>

        {/* Create Modal Dialog */}
        <Modal open={showCreateDialog} onClose={() => setShowCreateDialog(false)}>
          <ModalOverflow>
            <ModalDialog
              aria-labelledby="create-modal-title"
              data-testid="whats-new-create-dialog"
              sx={{
                width: { xs: '95%', sm: '90%' },
                maxWidth: MODAL_MAX_WIDTH,
                minWidth: { xs: 'auto', sm: MODAL_MIN_WIDTH },
              }}
            >
              <ModalClose />
              <Typography id="create-modal-title" level="h4" sx={{ mb: 2 }}>
                Create What&apos;s New Modal
              </Typography>
              <Stack spacing={2}>
                <FormControl required>
                  <FormLabel>Title</FormLabel>
                  <Input
                    placeholder="e.g., New Feature: Dark Mode"
                    value={newModalData.title}
                    onChange={e => setNewModalData(prev => ({ ...prev, title: e.target.value }))}
                    data-testid="whats-new-create-title-input"
                  />
                </FormControl>
                <FormControl required>
                  <FormLabel>Display Date</FormLabel>
                  <Input
                    type="date"
                    value={newModalData.displayDate}
                    onChange={e => setNewModalData(prev => ({ ...prev, displayDate: e.target.value }))}
                    data-testid="whats-new-create-displaydate-input"
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>
                    Subtitle
                    <Typography level="body-xs" component="span" sx={{ ml: 1, color: 'text.tertiary' }}>
                      (Optional)
                    </Typography>
                  </FormLabel>
                  <Input
                    placeholder="e.g., Customize your experience"
                    value={newModalData.subtitle}
                    onChange={e => setNewModalData(prev => ({ ...prev, subtitle: e.target.value }))}
                    data-testid="whats-new-create-subtitle-input"
                  />
                </FormControl>
                <FormControl required>
                  <FormLabel>Description</FormLabel>
                  <Textarea
                    minRows={DESCRIPTION_MIN_ROWS}
                    placeholder="Describe the new feature or update... (Markdown supported)"
                    value={newModalData.description}
                    onChange={e => setNewModalData(prev => ({ ...prev, description: e.target.value }))}
                    data-testid="whats-new-create-description-input"
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>
                    Expiry Date
                    <Typography level="body-xs" component="span" sx={{ ml: 1, color: 'text.tertiary' }}>
                      (Optional - defaults to 30 days)
                    </Typography>
                  </FormLabel>
                  <Input
                    type="date"
                    value={newModalData.endDate}
                    onChange={e => setNewModalData(prev => ({ ...prev, endDate: e.target.value }))}
                    slotProps={{
                      input: { min: getLocalDate(), max: getMaxExpiryDate() },
                    }}
                    data-testid="whats-new-create-enddate-input"
                  />
                </FormControl>
                <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
                  <Button variant="plain" color="neutral" onClick={() => setShowCreateDialog(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreateModal}
                    disabled={!newModalData.title.trim() || !newModalData.description.trim() || createModal.isPending}
                    loading={createModal.isPending}
                    data-testid="whats-new-create-submit-btn"
                  >
                    Create
                  </Button>
                </Stack>
              </Stack>
            </ModalDialog>
          </ModalOverflow>
        </Modal>

        {/* Preview Modal Dialog */}
        <Modal open={!!previewModal} onClose={() => setPreviewModal(null)}>
          <ModalDialog
            aria-labelledby="preview-modal-title"
            data-testid="whats-new-preview-dialog"
            sx={{ width: '90%', maxWidth: PREVIEW_MAX_WIDTH, minWidth: MODAL_MIN_WIDTH }}
          >
            <ModalClose />
            {previewModal && (
              <Stack spacing={2}>
                <Typography id="preview-modal-title" level="h4">
                  {previewModal.title ?? 'What’s New'}
                </Typography>

                {rawModalLoading ? (
                  <Stack alignItems="center" sx={{ py: 2 }}>
                    <CircularProgress size="sm" />
                  </Stack>
                ) : (
                  (() => {
                    const presentVariants = AUDIENCE_VARIANTS_CLIENT.filter(v => rawModal?.variants?.[v.key]?.title);
                    if (presentVariants.length) {
                      const activeVariant =
                        presentVariants.find(v => v.key === previewVariantTab) ?? presentVariants[0];
                      const c = rawModal!.variants![activeVariant.key]!;
                      return (
                        <Stack spacing={1.5}>
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                            {presentVariants.map(v => (
                              <Chip
                                key={v.key}
                                variant={previewVariantTab === v.key ? 'solid' : 'soft'}
                                color={v.audienceType === 'internal' ? 'warning' : 'success'}
                                onClick={() => setPreviewVariantTab(v.key)}
                                data-testid={`whats-new-preview-variant-tab-${v.key}`}
                              >
                                {v.label}
                              </Chip>
                            ))}
                          </Stack>
                          <Box sx={{ maxHeight: PREVIEW_MAX_HEIGHT, overflow: 'auto' }}>
                            <Typography level="title-md" sx={{ color: 'primary.500' }}>
                              {c.title}
                            </Typography>
                            {c.subtitle && (
                              <Typography level="body-sm" sx={{ color: 'text.secondary', mt: 0.5 }}>
                                {c.subtitle}
                              </Typography>
                            )}
                            {c.description && (
                              <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', mt: 1 }}>
                                {c.description}
                              </Typography>
                            )}
                          </Box>
                        </Stack>
                      );
                    }
                    // Legacy modal - render top-level content.
                    return (
                      <Box sx={{ maxHeight: PREVIEW_MAX_HEIGHT, overflow: 'auto' }}>
                        {previewModal.subtitle && (
                          <Typography level="title-md" sx={{ color: 'text.secondary', mb: 1 }}>
                            {previewModal.subtitle}
                          </Typography>
                        )}
                        <Typography level="body-md" sx={{ whiteSpace: 'pre-wrap' }}>
                          {previewModal.description}
                        </Typography>
                      </Box>
                    );
                  })()
                )}

                <Divider />

                <Stack direction="row" spacing={2} flexWrap="wrap">
                  <Chip size="sm" variant="outlined" color={previewModal.enabled ? 'success' : 'neutral'}>
                    {previewModal.enabled ? 'Enabled' : 'Disabled'}
                  </Chip>
                  <Chip size="sm" variant="outlined">
                    Source: {previewModal.generationMetadata?.importedFrom || 'self'}
                  </Chip>
                  {previewModal.generationMetadata?.generatedDate && (
                    <Chip size="sm" variant="outlined">
                      Generated: {previewModal.generationMetadata.generatedDate}
                    </Chip>
                  )}
                  {previewModal.endDate && (
                    <Chip size="sm" variant="outlined" color={getExpiryStatus(previewModal.endDate).color}>
                      Expires: {formatDateISO(previewModal.endDate)}
                    </Chip>
                  )}
                </Stack>
              </Stack>
            )}
          </ModalDialog>
        </Modal>

        {/* Edit Modal Dialog */}
        <Modal open={!!editModal} onClose={() => setEditModal(null)}>
          <ModalOverflow>
            <ModalDialog
              aria-labelledby="edit-modal-title"
              data-testid="whats-new-edit-dialog"
              sx={{
                width: { xs: '95%', sm: '90%' },
                maxWidth: MODAL_MAX_WIDTH,
                minWidth: { xs: 'auto', sm: MODAL_MIN_WIDTH },
              }}
            >
              <ModalClose />
              <Typography id="edit-modal-title" level="h4" sx={{ mb: 2 }}>
                Edit What&apos;s New Modal
              </Typography>
              {rawModalLoading ? (
                <Stack alignItems="center" sx={{ py: 3 }}>
                  <CircularProgress size="sm" />
                </Stack>
              ) : (
                <Stack spacing={2}>
                  {isVariantModal ? (
                    <>
                      {/* Variant tab picker */}
                      <FormControl>
                        <FormLabel>Variant</FormLabel>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {AUDIENCE_VARIANTS_CLIENT.map(v => {
                            const hasContent = !!editVariantData[v.key].title.trim();
                            return (
                              <Chip
                                key={v.key}
                                variant={editVariantTab === v.key ? 'solid' : 'soft'}
                                color={editVariantTab === v.key ? 'primary' : hasContent ? 'success' : 'neutral'}
                                onClick={() => setEditVariantTab(v.key)}
                                data-testid={`whats-new-edit-variant-tab-${v.key}`}
                              >
                                {v.label}
                                {hasContent ? ' ●' : ''}
                              </Chip>
                            );
                          })}
                        </Stack>
                        <FormHelperText>
                          A green dot marks variants with content. Empty title removes that variant on save.
                        </FormHelperText>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Title</FormLabel>
                        <Input
                          value={editVariantData[editVariantTab].title}
                          onChange={e =>
                            setEditVariantData(prev => ({
                              ...prev,
                              [editVariantTab]: { ...prev[editVariantTab], title: e.target.value },
                            }))
                          }
                          data-testid="whats-new-edit-variant-title-input"
                        />
                      </FormControl>
                      <FormControl>
                        <FormLabel>Subtitle</FormLabel>
                        <Input
                          value={editVariantData[editVariantTab].subtitle}
                          onChange={e =>
                            setEditVariantData(prev => ({
                              ...prev,
                              [editVariantTab]: { ...prev[editVariantTab], subtitle: e.target.value },
                            }))
                          }
                          data-testid="whats-new-edit-variant-subtitle-input"
                        />
                      </FormControl>
                      <FormControl>
                        <FormLabel>Description</FormLabel>
                        <Textarea
                          minRows={DESCRIPTION_MIN_ROWS}
                          value={editVariantData[editVariantTab].description}
                          onChange={e =>
                            setEditVariantData(prev => ({
                              ...prev,
                              [editVariantTab]: { ...prev[editVariantTab], description: e.target.value },
                            }))
                          }
                          data-testid="whats-new-edit-variant-description-input"
                        />
                      </FormControl>
                    </>
                  ) : (
                    <>
                      <FormControl required>
                        <FormLabel>Title</FormLabel>
                        <Input
                          placeholder="e.g., New Feature: Dark Mode"
                          value={editModalData.title}
                          onChange={e => setEditModalData(prev => ({ ...prev, title: e.target.value }))}
                          data-testid="whats-new-edit-title-input"
                        />
                      </FormControl>
                      <FormControl required>
                        <FormLabel>Display Date</FormLabel>
                        <Input
                          type="date"
                          value={editModalData.displayDate}
                          onChange={e => setEditModalData(prev => ({ ...prev, displayDate: e.target.value }))}
                          data-testid="whats-new-edit-displaydate-input"
                        />
                      </FormControl>
                      <FormControl>
                        <FormLabel>
                          Subtitle
                          <Typography level="body-xs" component="span" sx={{ ml: 1, color: 'text.tertiary' }}>
                            (Optional)
                          </Typography>
                        </FormLabel>
                        <Input
                          placeholder="e.g., Customize your experience"
                          value={editModalData.subtitle}
                          onChange={e => setEditModalData(prev => ({ ...prev, subtitle: e.target.value }))}
                          data-testid="whats-new-edit-subtitle-input"
                        />
                      </FormControl>
                      <FormControl required>
                        <FormLabel>Description</FormLabel>
                        <Textarea
                          minRows={DESCRIPTION_MIN_ROWS}
                          placeholder="Describe the new feature or update... (Markdown supported)"
                          value={editModalData.description}
                          onChange={e => setEditModalData(prev => ({ ...prev, description: e.target.value }))}
                          data-testid="whats-new-edit-description-input"
                        />
                      </FormControl>
                    </>
                  )}
                  <FormControl>
                    <FormLabel>
                      Expiry Date
                      <Typography level="body-xs" component="span" sx={{ ml: 1, color: 'text.tertiary' }}>
                        (Optional)
                      </Typography>
                    </FormLabel>
                    <Input
                      type="date"
                      value={isVariantModal ? editEndDate : editModalData.endDate}
                      onChange={e =>
                        isVariantModal
                          ? setEditEndDate(e.target.value)
                          : setEditModalData(prev => ({ ...prev, endDate: e.target.value }))
                      }
                      slotProps={{
                        input: { min: getLocalDate(), max: getMaxExpiryDate() },
                      }}
                      data-testid="whats-new-edit-enddate-input"
                    />
                  </FormControl>
                  <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
                    <Button variant="plain" color="neutral" onClick={() => setEditModal(null)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={handleEditModal}
                      disabled={
                        isVariantModal
                          ? !Object.values(editVariantData).some(v => v.title.trim()) || updateVariants.isPending
                          : !editModalData.title.trim() || !editModalData.description.trim() || updateModal.isPending
                      }
                      loading={updateVariants.isPending || updateModal.isPending}
                      data-testid="whats-new-edit-submit-btn"
                    >
                      Save Changes
                    </Button>
                  </Stack>
                </Stack>
              )}
            </ModalDialog>
          </ModalOverflow>
        </Modal>

        {/* Delete Confirmation Dialog */}
        <Modal open={!!modalToDelete} onClose={() => setDeleteConfirmModal(null)}>
          <ModalDialog
            aria-labelledby="delete-confirm-title"
            data-testid="whats-new-delete-confirm-dialog"
            sx={{ maxWidth: MODAL_MAX_WIDTH }}
          >
            <ModalClose />
            <Typography id="delete-confirm-title" level="h4" sx={{ mb: 1 }}>
              Delete Modal
            </Typography>
            <Typography level="body-md" sx={{ mb: 2 }}>
              Are you sure you want to delete &quot;{modalToDelete?.title}&quot;? This action cannot be undone.
            </Typography>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button variant="plain" color="neutral" onClick={() => setDeleteConfirmModal(null)}>
                Cancel
              </Button>
              <Button
                color="danger"
                onClick={() => {
                  if (modalToDelete?._id) {
                    deleteModal.mutate(modalToDelete._id.toString());
                    setDeleteConfirmModal(null);
                  }
                }}
                loading={deleteModal.isPending}
                data-testid="whats-new-delete-confirm-btn"
              >
                Delete
              </Button>
            </Stack>
          </ModalDialog>
        </Modal>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress aria-label="Loading modals" />
          </Box>
        ) : !modals?.length ? (
          <Alert variant="outlined" color="neutral">
            {isSourceEnvironment
              ? "No What's New modals found. Modals are auto-generated from production deployments."
              : "No What's New modals found. Sync from production to import modals."}
          </Alert>
        ) : (
          <Stack spacing={3}>
            {/* Active Modals Section */}
            <Box role="region" aria-labelledby="active-modals-heading">
              <Typography level="title-md" sx={{ mb: 1 }} id="active-modals-heading">
                Active Modals ({sortedActiveModals.length})
              </Typography>
              {sortedActiveModals.length === 0 ? (
                <Alert variant="outlined" color="neutral">
                  No active modals. All modals are either disabled or expired.
                </Alert>
              ) : (
                <>
                  {isMobile ? (
                    <Stack spacing={1} data-testid="whats-new-active-table">
                      {paginatedActiveModals.map((modal: IModalDocument) => (
                        <ModalMobileCard
                          key={modal._id?.toString() ?? 'unknown'}
                          modal={modal}
                          onView={setPreviewModal}
                          onEdit={handleOpenEditDialog}
                          onToggle={handleToggleModal}
                          onDelete={setDeleteConfirmModal}
                          isTogglePending={toggleModal.isPending}
                          isDeletePending={deleteModal.isPending}
                          testIdPrefix="whats-new-row"
                        />
                      ))}
                    </Stack>
                  ) : (
                    <Sheet
                      variant="outlined"
                      sx={{ borderRadius: 'sm', overflow: 'auto' }}
                      data-testid="whats-new-active-table"
                    >
                      <Table stickyHeader aria-label="Active What's New modals table">
                        <thead>
                          <tr>
                            <th style={{ width: '32%' }}>Title</th>
                            <th style={{ width: '12%' }}>Date</th>
                            <th style={{ width: '12%' }}>Status</th>
                            <th style={{ width: '12%' }}>Expiry</th>
                            <th style={{ width: '12%' }}>Source</th>
                            <th style={{ width: '20%' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedActiveModals.map((modal: IModalDocument) => (
                            <ModalTableRow
                              key={modal._id?.toString() ?? 'unknown'}
                              modal={modal}
                              onView={setPreviewModal}
                              onEdit={handleOpenEditDialog}
                              onToggle={handleToggleModal}
                              onDelete={setDeleteConfirmModal}
                              isTogglePending={toggleModal.isPending}
                              isDeletePending={deleteModal.isPending}
                              testIdPrefix="whats-new-row"
                            />
                          ))}
                        </tbody>
                      </Table>
                    </Sheet>
                  )}

                  {/* Pagination Controls */}
                  {sortedActiveModals.length > itemsPerPage && (
                    <Box aria-live="polite" data-testid="whats-new-pagination">
                      <PaginationControls
                        currentPage={currentPage}
                        totalPages={totalPages}
                        itemsPerPage={itemsPerPage}
                        totalItems={sortedActiveModals.length}
                        onPageChange={handlePageChange}
                        onItemsPerPageChange={handleItemsPerPageChange}
                      />
                    </Box>
                  )}
                </>
              )}
            </Box>

            {/* Archived Modals Section */}
            {sortedArchivedModals.length > 0 && (
              <AccordionGroup data-testid="whats-new-archived-section">
                <Accordion
                  expanded={archivedExpanded}
                  onChange={(_, expanded) => setArchivedExpanded(expanded ?? false)}
                >
                  <AccordionSummary
                    indicator={<ExpandMoreIcon />}
                    aria-controls="archived-modals-content"
                    id="archived-modals-header"
                    data-testid="whats-new-archived-toggle-btn"
                  >
                    <Typography level="title-md">Archived Modals ({sortedArchivedModals.length})</Typography>
                  </AccordionSummary>
                  <AccordionDetails
                    id="archived-modals-content"
                    role="region"
                    aria-labelledby="archived-modals-header"
                    slotProps={{ content: { sx: { p: 0, mt: '4px' } } }}
                  >
                    {isMobile ? (
                      <Stack spacing={1} data-testid="whats-new-archived-table">
                        {paginatedArchivedModals.map((modal: IModalDocument) => (
                          <ModalMobileCard
                            key={modal._id?.toString() ?? 'unknown'}
                            modal={modal}
                            onView={setPreviewModal}
                            onEdit={handleOpenEditDialog}
                            onToggle={handleToggleModal}
                            onDelete={setDeleteConfirmModal}
                            isTogglePending={toggleModal.isPending}
                            isDeletePending={deleteModal.isPending}
                            testIdPrefix="whats-new-archived-row"
                          />
                        ))}
                      </Stack>
                    ) : (
                      <Sheet
                        variant="outlined"
                        sx={{ borderRadius: 'sm', overflow: 'auto' }}
                        data-testid="whats-new-archived-table"
                      >
                        <Table stickyHeader aria-label="Archived What's New modals table">
                          <thead>
                            <tr>
                              <th style={{ width: '32%' }}>Title</th>
                              <th style={{ width: '12%' }}>Date</th>
                              <th style={{ width: '12%' }}>Status</th>
                              <th style={{ width: '12%' }}>Expiry</th>
                              <th style={{ width: '12%' }}>Source</th>
                              <th style={{ width: '20%' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {paginatedArchivedModals.map((modal: IModalDocument) => (
                              <ModalTableRow
                                key={modal._id?.toString() ?? 'unknown'}
                                modal={modal}
                                onView={setPreviewModal}
                                onEdit={handleOpenEditDialog}
                                onToggle={handleToggleModal}
                                onDelete={setDeleteConfirmModal}
                                isTogglePending={toggleModal.isPending}
                                isDeletePending={deleteModal.isPending}
                                testIdPrefix="whats-new-archived-row"
                              />
                            ))}
                          </tbody>
                        </Table>
                      </Sheet>
                    )}

                    {/* Archived Pagination Controls */}
                    {sortedArchivedModals.length > archivedItemsPerPage && (
                      <Box aria-live="polite" data-testid="whats-new-archived-pagination">
                        <PaginationControls
                          currentPage={archivedPage}
                          totalPages={archivedTotalPages}
                          itemsPerPage={archivedItemsPerPage}
                          totalItems={sortedArchivedModals.length}
                          onPageChange={handleArchivedPageChange}
                          onItemsPerPageChange={handleArchivedItemsPerPageChange}
                        />
                      </Box>
                    )}
                  </AccordionDetails>
                </Accordion>
              </AccordionGroup>
            )}
          </Stack>
        )}
      </Box>
    </Card>
  );
}

/**
 * Available modals section showing modals available from production S3.
 * Only rendered when distribution URL is configured.
 */
function AvailableModalsCard() {
  const { data: availableData, isLoading, refetch } = useGetAvailableWhatsNewModals();
  const importModals = useImportWhatsNewModals();
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // Pagination state
  const [availablePage, setAvailablePage] = useState(1);
  const [availableItemsPerPage, setAvailableItemsPerPage] = useState(20);

  const modals = availableData?.modals || [];
  const availableModals = modals.filter(m => m.status === 'available');

  // Calculate pagination
  const availableTotalPages = Math.ceil(modals.length / availableItemsPerPage);
  const availableStartIndex = (availablePage - 1) * availableItemsPerPage;
  const availableEndIndex = availableStartIndex + availableItemsPerPage;
  const paginatedModals = modals.slice(availableStartIndex, availableEndIndex);

  // Reset to page 1 when total pages decrease below current page
  useEffect(() => {
    if (availablePage > 1 && availablePage > availableTotalPages) {
      setAvailablePage(1);
    }
  }, [availableTotalPages, availablePage]);

  // Pagination handlers
  const handleAvailablePageChange = useCallback((page: number) => {
    setAvailablePage(page);
  }, []);

  const handleAvailableItemsPerPageChange = useCallback((items: number) => {
    setAvailableItemsPerPage(items);
    setAvailablePage(1);
  }, []);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedKeys(new Set(availableModals.map(m => m.key)));
    } else {
      setSelectedKeys(new Set());
    }
  };

  const handleSelectOne = (key: string, checked: boolean) => {
    const newSet = new Set(selectedKeys);
    if (checked) {
      newSet.add(key);
    } else {
      newSet.delete(key);
    }
    setSelectedKeys(newSet);
  };

  const handleImportSelected = () => {
    if (selectedKeys.size > 0) {
      importModals.mutate(Array.from(selectedKeys), {
        onSuccess: () => {
          setSelectedKeys(new Set());
          setAvailablePage(1);
          refetch();
        },
      });
    }
  };

  const handleImportAll = () => {
    const keys = availableModals.map(m => m.key);
    if (keys.length > 0) {
      importModals.mutate(keys, {
        onSuccess: () => {
          setSelectedKeys(new Set());
          setAvailablePage(1);
          refetch();
        },
      });
    }
  };

  const allSelected = availableModals.length > 0 && selectedKeys.size === availableModals.length;
  const someSelected = selectedKeys.size > 0 && selectedKeys.size < availableModals.length;

  return (
    <Card variant="outlined">
      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <CloudDownloadIcon color="primary" />
            <Typography level="title-lg">Available for Sync</Typography>
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button
              variant="soft"
              color="primary"
              size="sm"
              startDecorator={importModals.isPending ? <CircularProgress size="sm" /> : <CloudDownloadIcon />}
              onClick={handleImportSelected}
              disabled={selectedKeys.size === 0 || importModals.isPending}
              data-testid="whats-new-import-selected-btn"
            >
              Import Selected ({selectedKeys.size})
            </Button>
            <Button
              variant="outlined"
              color="primary"
              size="sm"
              onClick={handleImportAll}
              disabled={availableModals.length === 0 || importModals.isPending}
              data-testid="whats-new-import-all-btn"
            >
              Import All ({availableModals.length})
            </Button>
            <IconButton
              variant="plain"
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading}
              aria-label="Refresh available modals"
              data-testid="whats-new-available-refresh-btn"
            >
              <RefreshIcon />
            </IconButton>
          </Stack>
        </Stack>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress aria-label="Loading available modals" />
          </Box>
        ) : !modals.length ? (
          <Alert variant="outlined" color="neutral">
            No modals available from production. Check if the manifest is published.
          </Alert>
        ) : (
          <>
            <Sheet
              variant="outlined"
              sx={{ borderRadius: 'sm', overflow: 'auto' }}
              data-testid="whats-new-available-table"
            >
              <Table stickyHeader aria-label="Available modals for sync table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>
                      <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        onChange={e => handleSelectAll(e.target.checked)}
                        disabled={availableModals.length === 0}
                        slotProps={{ input: { 'aria-label': 'Select all available modals' } }}
                      />
                    </th>
                    <th style={{ width: '35%' }}>Title</th>
                    <th style={{ width: '15%' }}>Date</th>
                    <th style={{ width: '15%' }}>Status</th>
                    <th style={{ width: '20%' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedModals.map((modal: AvailableModalEntry) => {
                    const isAvailable = modal.status === 'available';
                    const isSelected = selectedKeys.has(modal.key);

                    return (
                      <tr key={modal.key}>
                        <td>
                          <Checkbox
                            checked={isSelected}
                            onChange={e => handleSelectOne(modal.key, e.target.checked)}
                            disabled={!isAvailable}
                          />
                        </td>
                        <td>
                          <Typography level="body-sm" noWrap sx={{ maxWidth: 250 }}>
                            {modal.title}
                          </Typography>
                        </td>
                        <td>
                          <Typography level="body-xs">{modal.generatedDate || 'N/A'}</Typography>
                        </td>
                        <td>
                          <Chip
                            size="sm"
                            variant="outlined"
                            color={isAvailable ? 'success' : 'neutral'}
                            startDecorator={isAvailable ? <PendingIcon /> : <CheckCircleIcon />}
                          >
                            {isAvailable ? 'Available' : 'Imported'}
                          </Chip>
                        </td>
                        <td>
                          {isAvailable && (
                            <Button
                              size="sm"
                              variant="plain"
                              startDecorator={<CloudDownloadIcon />}
                              onClick={() =>
                                importModals.mutate([modal.key], {
                                  onSuccess: () => {
                                    setAvailablePage(1);
                                    refetch();
                                  },
                                })
                              }
                              disabled={importModals.isPending}
                            >
                              Import
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Sheet>

            {/* Available Pagination Controls */}
            {modals.length > availableItemsPerPage && (
              <Box aria-live="polite" data-testid="whats-new-available-pagination">
                <PaginationControls
                  currentPage={availablePage}
                  totalPages={availableTotalPages}
                  itemsPerPage={availableItemsPerPage}
                  totalItems={modals.length}
                  onPageChange={handleAvailablePageChange}
                  onItemsPerPageChange={handleAvailableItemsPerPageChange}
                />
              </Box>
            )}
          </>
        )}
      </Box>
    </Card>
  );
}

/**
 * Daily Generation Card - consolidated section for modal generation.
 * Includes enable toggle, health status, dry run / run now buttons (modal-based),
 * and collapsible configuration. Follows the LiveOps triage UX pattern.
 */
function DailyGenerationCard() {
  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useGetGenerationStatus();
  const automationEnabled = useGetSettingsValue('whatsNewAutomationEnabled') as boolean | undefined;
  const updateSettings = useUpdateSettings();
  const backfill = useBackfillWhatsNew();

  // Backfill modal state
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillDryRun, setBackfillDryRun] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Check if no successful generation in 48+ hours
  const [isStale, setIsStale] = useState(true);
  useEffect(() => {
    if (!status?.lastCompletedAt) {
      setIsStale(true);
      return;
    }
    const elapsed = Date.now() - new Date(status.lastCompletedAt).getTime();
    setIsStale(elapsed > 48 * 60 * 60 * 1000);
  }, [status?.lastCompletedAt]);

  const getGenStatusColor = (
    s: GenerationStatusResponse['lastStatus']
  ): 'success' | 'danger' | 'warning' | 'neutral' => {
    switch (s) {
      case 'success':
        return 'success';
      case 'failed':
        return 'danger';
      case 'no_changes':
      case 'skipped':
      case 'no_prs':
        return 'neutral';
      default:
        return 'warning';
    }
  };

  const getGenStatusLabel = (s: GenerationStatusResponse['lastStatus']): string => {
    switch (s) {
      case 'success':
        return 'Success';
      case 'failed':
        return 'Failed';
      case 'no_changes':
        return 'No User-Facing Changes';
      case 'skipped':
        return 'Skipped (Duplicate)';
      case 'no_prs':
        return 'No PRs Found';
      default:
        return 'Unknown';
    }
  };

  const generateDates = (): string[] => {
    if (!startDate || !endDate) return [];
    const dates: string[] = [];
    const current = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    while (current <= end) {
      dates.push(current.toISOString().split('T')[0]);
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  };

  const handleRunSubmit = () => {
    const dates = generateDates();
    if (dates.length === 0) return;
    backfill.mutate({ dates, dryRun: backfillDryRun });
    setBackfillOpen(false);
  };

  return (
    <Card variant="outlined">
      <Box>
        {/* Header */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          gap={1}
          sx={{ mb: 1 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <CodeIcon color="primary" />
            <Typography level="title-lg">Daily Modal Generation</Typography>
            {!statusLoading && (
              <Chip size="sm" variant="outlined" color={automationEnabled ? 'success' : 'neutral'}>
                {automationEnabled ? 'Enabled' : 'Disabled'}
              </Chip>
            )}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ width: { xs: '100%', sm: 'auto' } }}>
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<PlayArrowIcon />}
              onClick={() => {
                setBackfillDryRun(true);
                setBackfillOpen(true);
              }}
              sx={{ flex: { xs: 1, sm: 'unset' } }}
            >
              Dry Run
            </Button>
            <Button
              size="sm"
              variant="solid"
              color="success"
              startDecorator={<PlayArrowIcon />}
              onClick={() => {
                setBackfillDryRun(false);
                setBackfillOpen(true);
              }}
              sx={{ flex: { xs: 1, sm: 'unset' } }}
            >
              Run Now
            </Button>
            <IconButton
              variant="plain"
              size="sm"
              onClick={() => refetchStatus()}
              disabled={statusLoading}
              aria-label="Refresh generation status"
              data-testid="generation-refresh-btn"
            >
              <RefreshIcon />
            </IconButton>
          </Stack>
        </Stack>

        <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 2 }}>
          Automated daily generation of What&apos;s New modals from merged pull requests. Runs daily at 1am CST
          (production only).
        </Typography>

        {/* Last Run Status Alert (like Weekly Highlights) */}
        {status?.lastStatus && (
          <Alert
            variant="outlined"
            color={getGenStatusColor(status.lastStatus)}
            startDecorator={
              status.lastStatus === 'success' ? (
                <CheckCircleIcon />
              ) : status.lastStatus === 'failed' ? (
                <ErrorIcon />
              ) : (
                <InfoIcon />
              )
            }
            sx={{ mb: 2 }}
          >
            <Box>
              <Typography level="body-sm" fontWeight="bold">
                Last Run: {getGenStatusLabel(status.lastStatus)}
              </Typography>
              <Stack direction="row" spacing={2} flexWrap="wrap">
                {status.lastCompletedAt && (
                  <Typography level="body-xs">
                    Completed: {new Date(status.lastCompletedAt).toLocaleString()}
                  </Typography>
                )}
                {status.lastGeneratedDate && <Typography level="body-xs">Date: {status.lastGeneratedDate}</Typography>}
                {status.lastModelUsed && <Typography level="body-xs">Model: {status.lastModelUsed}</Typography>}
              </Stack>
              {status.lastStatus === 'failed' && status.lastError && (
                <Typography level="body-xs" sx={{ mt: 0.5 }}>
                  Error: {status.lastError}
                </Typography>
              )}
            </Box>
          </Alert>
        )}

        {/* Staleness Warning */}
        {isStale && status?.lastStatus !== null && (
          <Alert variant="outlined" color="warning" startDecorator={<WarningIcon />} sx={{ mb: 2 }}>
            No successful generation in the last 48 hours. Daily modal generation may not be running.
          </Alert>
        )}

        {/* Backfill Results (shown inline after running) */}
        {backfill.data && (
          <Box sx={{ mb: 2 }}>
            <Alert variant="outlined" color={backfill.data.failed.length > 0 ? 'warning' : 'success'} sx={{ mb: 1 }}>
              {backfill.data.dryRun ? 'Dry run results' : 'Backfill results'}: {backfill.data.queued.length}{' '}
              {backfill.data.dryRun ? 'would generate' : 'queued'}, {backfill.data.skipped.length} skipped,{' '}
              {backfill.data.noPRs.length} no PRs, {backfill.data.failed.length} failed
            </Alert>
            {backfill.data.details.length > 0 && (
              <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto', maxHeight: 300 }}>
                <Table size="sm" stickyHeader>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Status</th>
                      <th>PRs</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backfill.data.details.map(d => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td>
                          <Chip
                            size="sm"
                            variant="outlined"
                            color={
                              d.status === 'queued' || d.status === 'would_generate'
                                ? 'success'
                                : d.status === 'failed'
                                  ? 'danger'
                                  : 'neutral'
                            }
                          >
                            {d.status}
                          </Chip>
                        </td>
                        <td>{d.prCount ?? '-'}</td>
                        <td>
                          <Typography level="body-xs">{d.reason || '-'}</Typography>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Sheet>
            )}
          </Box>
        )}

        {/* Configuration Accordion */}
        <AccordionGroup>
          <Accordion>
            <AccordionSummary indicator={<ExpandMoreIcon />}>
              <Typography level="title-sm">Configuration</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={2} sx={{ pt: 1 }}>
                {/* Enable/Disable Toggle */}
                <Stack direction="row" spacing={2} alignItems="center">
                  <Switch
                    checked={automationEnabled ?? false}
                    onChange={e => updateSettings.mutate({ key: 'whatsNewAutomationEnabled', value: e.target.checked })}
                    color={automationEnabled ? 'success' : 'neutral'}
                  />
                  <Box>
                    <Typography level="body-md" fontWeight="bold">
                      {automationEnabled ? 'Enabled' : 'Disabled'}
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      Daily automated generation is {automationEnabled ? 'on' : 'off'}
                    </Typography>
                  </Box>
                </Stack>
                <Divider />
                <AdminWhatsNewConfiguration />
              </Stack>
            </AccordionDetails>
          </Accordion>
        </AccordionGroup>
      </Box>

      {/* Run / Dry Run Modal (LiveOps pattern) */}
      <Modal open={backfillOpen} onClose={() => setBackfillOpen(false)}>
        <ModalDialog variant="outlined" sx={{ maxWidth: 400 }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            {backfillDryRun ? 'Dry Run Generation?' : 'Run Generation Now?'}
          </Typography>
          <Typography level="body-sm" sx={{ mb: 2 }}>
            {backfillDryRun
              ? 'This will check which dates have merged PRs and preview what would be generated, without dispatching any jobs.'
              : 'This will dispatch generation jobs for each date. Each date consumes an LLM call.'}
          </Typography>
          <Stack spacing={2} sx={{ mb: 2 }}>
            <FormControl>
              <FormLabel>Start Date</FormLabel>
              <Input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                slotProps={{ input: { max: new Date().toISOString().split('T')[0] } }}
              />
            </FormControl>
            <FormControl>
              <FormLabel>End Date</FormLabel>
              <Input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                slotProps={{ input: { max: new Date().toISOString().split('T')[0] } }}
              />
            </FormControl>
          </Stack>
          {!backfillDryRun && (
            <Alert color="warning" variant="outlined" sx={{ mb: 2 }}>
              <Typography level="body-sm">Real generation jobs will be dispatched!</Typography>
            </Alert>
          )}
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
            <Button variant="plain" color="neutral" onClick={() => setBackfillOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              color={backfillDryRun ? 'primary' : 'success'}
              startDecorator={backfill.isPending ? <CircularProgress size="sm" /> : <PlayArrowIcon />}
              onClick={handleRunSubmit}
              disabled={!startDate || !endDate || backfill.isPending}
            >
              {backfillDryRun ? 'Run Dry Test' : 'Run Now'}
            </Button>
          </Box>
        </ModalDialog>
      </Modal>
    </Card>
  );
}

/**
 * Weekly Highlights configuration card for posting highlights to Slack.
 * Only visible on main environments (production/dev), not fork environments.
 */
function WeeklyHighlightsCard() {
  const { data: configData, isLoading, refetch } = useGetHighlightsConfig();
  const updateConfig = useUpdateHighlightsConfig();
  const generateHighlights = useGenerateHighlights();
  const { data: models } = useModelInfo();
  const [showPreview, setShowPreview] = useState(false);
  const [showDefaultTemplate, setShowDefaultTemplate] = useState(false);

  // Local state for form
  const [enabled, setEnabled] = useState(false);
  const [slackChannelId, setSlackChannelId] = useState('');
  const [slackTeamId, setSlackTeamId] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [promptTemplate, setPromptTemplate] = useState('');
  const [attachMarkdownFile, setAttachMarkdownFile] = useState(true);
  const [configExpanded, setConfigExpanded] = useState(false);
  const [highlightsPreviewOpen, setHighlightsPreviewOpen] = useState(false);
  const [highlightsPreviewContent, setHighlightsPreviewContent] = useState('');
  const highlightsPreviewMutation = useMutation({
    mutationFn: async (template?: string) => {
      const response = await api.post('/api/admin/whats-new-highlights-preview', { template });
      return response.data;
    },
    onSuccess: (data: { preview: string }) => {
      setHighlightsPreviewContent(data.preview);
      setHighlightsPreviewOpen(true);
    },
    onError: (error: unknown) => {
      toast.error(`Preview generation failed: ${getErrorMessage(error)}`);
    },
  });
  const [highlightsModalOpen, setHighlightsModalOpen] = useState(false);
  const [highlightsDryRun, setHighlightsDryRun] = useState(true);
  const [highlightsStartDate, setHighlightsStartDate] = useState('');
  const [highlightsEndDate, setHighlightsEndDate] = useState('');
  const [highlightsResult, setHighlightsResult] = useState<{
    modalCount?: number;
    modals?: Array<{ title: string; subtitle: string; descriptionPreview: string; createdAt: string }>;
    dateRange?: { startDate: string; endDate: string };
    message?: string;
  } | null>(null);

  // Get text models grouped by provider
  const textModels = models?.filter(m => m.type === 'text') || [];
  const modelsByProvider = textModels.reduce(
    (acc, model) => {
      const provider = model.backend || 'unknown';
      if (!acc[provider]) acc[provider] = [];
      acc[provider].push(model);
      return acc;
    },
    {} as Record<string, typeof textModels>
  );
  const currentModelInfo = textModels.find(m => m.id === llmModel);

  // Initialize from config
  useEffect(() => {
    if (configData) {
      setEnabled(configData.enabled ?? false);
      setSlackChannelId(configData.slackChannelId ?? '');
      setSlackTeamId(configData.slackTeamId ?? '');
      setLlmModel(configData.llmModel ?? '');
      setPromptTemplate(configData.promptTemplate ?? '');
      setAttachMarkdownFile(configData.attachMarkdownFile ?? true);
    }
  }, [configData]);

  // Computed dirty tracking (same pattern as Daily Gen and LiveOps)
  const isDirty = configData
    ? JSON.stringify({ enabled, slackChannelId, slackTeamId, llmModel, promptTemplate, attachMarkdownFile }) !==
      JSON.stringify({
        enabled: configData.enabled ?? false,
        slackChannelId: configData.slackChannelId ?? '',
        slackTeamId: configData.slackTeamId ?? '',
        llmModel: configData.llmModel ?? '',
        promptTemplate: configData.promptTemplate ?? '',
        attachMarkdownFile: configData.attachMarkdownFile ?? true,
      })
    : false;

  const handleSave = () => {
    updateConfig.mutate(
      {
        enabled,
        slackChannelId: slackChannelId || undefined,
        slackTeamId: slackTeamId || undefined,
        llmModel: llmModel || undefined,
        promptTemplate: promptTemplate || undefined,
        attachMarkdownFile,
      },
      {
        onSuccess: () => {
          refetch();
        },
      }
    );
  };

  const highlightsTextareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInsertVariable = useCallback(
    (variable: string) => {
      const textarea = highlightsTextareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const currentValue = promptTemplate;
      const variableText = `{{${variable}}}`;
      const newValue = currentValue.substring(0, start) + variableText + currentValue.substring(end);

      setPromptTemplate(newValue);

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + variableText.length;
        textarea.focus();
      }, 0);
    },
    [promptTemplate]
  );

  const handleFieldChange = <T,>(setter: React.Dispatch<React.SetStateAction<T>>, value: T) => {
    setter(value);
  };

  const handleReset = () => {
    if (configData) {
      setEnabled(configData.enabled ?? false);
      setSlackChannelId(configData.slackChannelId ?? '');
      setSlackTeamId(configData.slackTeamId ?? '');
      setLlmModel(configData.llmModel ?? '');
      setPromptTemplate(configData.promptTemplate ?? '');
      setAttachMarkdownFile(configData.attachMarkdownFile ?? true);
    }
  };

  const getStatusColor = (status: string | null): 'success' | 'danger' | 'warning' | 'neutral' => {
    switch (status) {
      case 'success':
        return 'success';
      case 'failed':
        return 'danger';
      case 'no_modals':
        return 'warning';
      default:
        return 'neutral';
    }
  };

  const getStatusLabel = (status: string | null): string => {
    switch (status) {
      case 'success':
        return 'Success';
      case 'failed':
        return 'Failed';
      case 'no_modals':
        return 'No modals found';
      default:
        return 'Never run';
    }
  };

  const openHighlightsModal = (dryRun: boolean) => {
    setHighlightsDryRun(dryRun);
    // Default: last 7 days
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    setHighlightsStartDate(start.toISOString().split('T')[0]);
    setHighlightsEndDate(end.toISOString().split('T')[0]);
    setHighlightsResult(null);
    setHighlightsModalOpen(true);
  };

  const handleHighlightsSubmit = () => {
    generateHighlights.mutate(
      {
        startDate: highlightsStartDate || undefined,
        endDate: highlightsEndDate || undefined,
        dryRun: highlightsDryRun,
      },
      {
        onSuccess: data => {
          if (highlightsDryRun) {
            setHighlightsResult(data);
          } else {
            setHighlightsModalOpen(false);
          }
        },
      }
    );
  };

  return (
    <Card variant="outlined">
      <Box>
        {/* Header - Always Visible */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          gap={1}
          sx={{ mb: 2 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <AutoAwesomeIcon color="primary" />
            <Typography level="title-lg">Weekly Highlights to Slack</Typography>
            {!isLoading && (
              <Chip
                size="sm"
                variant="outlined"
                color={enabled ? 'success' : 'neutral'}
                data-testid="highlights-status-chip"
              >
                {enabled ? 'Enabled' : 'Disabled'}
              </Chip>
            )}
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ width: { xs: '100%', sm: 'auto' } }}>
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<PlayArrowIcon />}
              onClick={() => openHighlightsModal(true)}
              disabled={generateHighlights.isPending}
              data-testid="highlights-dry-run-btn"
              sx={{ flex: { xs: 1, sm: 'unset' } }}
            >
              Dry Run
            </Button>
            <Button
              size="sm"
              variant="solid"
              color="success"
              startDecorator={<PlayArrowIcon />}
              onClick={() => openHighlightsModal(false)}
              disabled={generateHighlights.isPending || !slackChannelId || !slackTeamId}
              data-testid="highlights-run-now-btn"
              sx={{ flex: { xs: 1, sm: 'unset' } }}
            >
              Run Now
            </Button>
            <IconButton
              variant="plain"
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading}
              aria-label="Refresh highlights config"
              data-testid="highlights-refresh-btn"
            >
              <RefreshIcon />
            </IconButton>
          </Stack>
        </Stack>

        <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 2 }}>
          Automatically generate weekly highlights from What&apos;s New modals and post them to a Slack channel. Runs
          every Saturday at 2am CST (production only).
        </Typography>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress aria-label="Loading highlights config" />
          </Box>
        ) : (
          <>
            {/* Last Run Status - Always Visible */}
            {configData?.lastStatus && (
              <Alert
                variant="outlined"
                color={getStatusColor(configData.lastStatus)}
                startDecorator={configData.lastStatus === 'success' ? <CheckCircleIcon /> : <ErrorIcon />}
                sx={{ mb: 2 }}
              >
                <Box>
                  <Typography level="body-sm" fontWeight="bold">
                    Last Run: {getStatusLabel(configData.lastStatus)}
                  </Typography>
                  {configData.lastCompletedAt && (
                    <Typography level="body-xs">
                      Completed: {new Date(configData.lastCompletedAt).toLocaleString()}
                    </Typography>
                  )}
                </Box>
                {configData.lastHighlights && (
                  <Button
                    size="sm"
                    variant="plain"
                    startDecorator={<VisibilityIcon />}
                    onClick={() => setShowPreview(true)}
                    sx={{ ml: 'auto' }}
                    data-testid="highlights-preview-btn"
                  >
                    Preview
                  </Button>
                )}
              </Alert>
            )}

            {/* Collapsible Configuration */}
            <AccordionGroup>
              <Accordion expanded={configExpanded} onChange={(_, expanded) => setConfigExpanded(expanded ?? false)}>
                <AccordionSummary indicator={<ExpandMoreIcon />}>
                  <Typography level="title-sm">Configuration</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={3} sx={{ pt: 1 }}>
                    {/* Enable/Disable Toggle */}
                    <Stack direction="row" spacing={2} alignItems="center">
                      <Switch
                        checked={enabled}
                        onChange={e => handleFieldChange(setEnabled, e.target.checked)}
                        color={enabled ? 'success' : 'neutral'}
                        data-testid="highlights-enabled-switch"
                      />
                      <Box>
                        <Typography level="body-md" fontWeight="bold">
                          {enabled ? 'Enabled' : 'Disabled'}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Weekly auto-generation is {enabled ? 'on' : 'off'}
                        </Typography>
                      </Box>
                    </Stack>

                    <Divider />

                    {/* Slack Configuration */}
                    <Typography level="title-sm">Slack Configuration</Typography>

                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <FormControl sx={{ flex: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <FormLabel sx={{ m: 0 }}>Slack Channel ID</FormLabel>
                          <FieldTooltip
                            ariaLabel="Help: Slack Channel ID"
                            content="The Slack channel ID (starts with C) where highlights will be posted"
                          />
                        </Box>
                        <Input
                          placeholder="e.g., C0123456789"
                          value={slackChannelId}
                          onChange={e => handleFieldChange(setSlackChannelId, e.target.value)}
                          data-testid="highlights-channel-id-input"
                        />
                      </FormControl>

                      <FormControl sx={{ flex: 1 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <FormLabel sx={{ m: 0 }}>Slack Team ID</FormLabel>
                          <FieldTooltip
                            ariaLabel="Help: Slack Team ID"
                            content="The Slack workspace/team ID (starts with T) for the connected workspace"
                          />
                        </Box>
                        <Input
                          placeholder="e.g., T0123456789"
                          value={slackTeamId}
                          onChange={e => handleFieldChange(setSlackTeamId, e.target.value)}
                          data-testid="highlights-team-id-input"
                        />
                      </FormControl>
                    </Stack>

                    {enabled && (!slackChannelId || !slackTeamId) && (
                      <Alert variant="outlined" color="warning" size="sm">
                        Slack channel and team ID are required when highlights are enabled.
                      </Alert>
                    )}

                    {/* Markdown File Attachment Option */}
                    <Stack direction="row" spacing={2} alignItems="center">
                      <Switch
                        checked={attachMarkdownFile}
                        onChange={e => handleFieldChange(setAttachMarkdownFile, e.target.checked)}
                        data-testid="highlights-attach-markdown-switch"
                      />
                      <Box>
                        <Typography level="body-md">
                          Attach markdown file
                          <FieldTooltip
                            ariaLabel="Help: Attach markdown file"
                            content="When enabled, a .md file will be attached to the Slack message for easy copy/paste into reports"
                          />
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          Include a downloadable markdown file with the highlights
                        </Typography>
                      </Box>
                    </Stack>

                    <Divider />

                    {/* LLM Configuration */}
                    <Typography level="title-sm">LLM Configuration</Typography>

                    <FormControl>
                      <FormLabel>Model</FormLabel>
                      <Select
                        value={llmModel}
                        onChange={(_, value) => {
                          if (value && !value.startsWith('__header_')) {
                            handleFieldChange(setLlmModel, value);
                          }
                        }}
                        placeholder="Select a model (default: gpt-4o-mini)"
                        data-testid="highlights-model-select"
                      >
                        {Object.entries(modelsByProvider)
                          .map(([provider, providerModels]) => [
                            <Option key={`${provider}-header`} value={`__header_${provider}`} disabled>
                              <Typography
                                level="body-xs"
                                sx={{ fontWeight: 'bold', textTransform: 'uppercase', color: 'text.primary' }}
                              >
                                {provider}
                              </Typography>
                            </Option>,
                            ...providerModels.map(model => (
                              <Option key={model.id} value={model.id}>
                                {model.name}
                              </Option>
                            )),
                          ])
                          .flat()}
                      </Select>
                      <FormHelperText>Model used for generating highlights summary</FormHelperText>
                    </FormControl>

                    {currentModelInfo && (
                      <Alert variant="outlined" size="sm" startDecorator={<CheckCircleIcon />}>
                        <Typography level="body-sm">
                          <strong>{currentModelInfo.name}</strong> ({currentModelInfo.backend}) •{' '}
                          {(currentModelInfo.contextWindow / 1000).toFixed(0)}K context
                        </Typography>
                      </Alert>
                    )}

                    <Divider />

                    {/* Prompt Template */}
                    <Typography level="title-sm">Custom Prompt Template (Optional)</Typography>

                    <Box sx={{ mb: 2 }}>
                      <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1 }}>
                        Available variables:
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        {Object.entries(HIGHLIGHTS_TEMPLATE_VARIABLES).map(([variable, description]) => (
                          <Tooltip key={variable} title={description}>
                            <Chip
                              size="sm"
                              variant="outlined"
                              onClick={() => handleInsertVariable(variable)}
                              sx={{ fontFamily: 'monospace', cursor: 'pointer' }}
                              data-testid={`highlights-variable-${variable}`}
                              endDecorator={
                                <IconButton
                                  size="sm"
                                  variant="plain"
                                  onClick={e => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(`{{${variable}}}`);
                                    toast.success(`Copied {{${variable}}} to clipboard`);
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

                    <FormControl>
                      <FormLabel>Prompt Template</FormLabel>
                      <Textarea
                        slotProps={{
                          textarea: {
                            ref: highlightsTextareaRef,
                          },
                        }}
                        minRows={12}
                        maxRows={24}
                        value={promptTemplate}
                        onChange={e => handleFieldChange(setPromptTemplate, e.target.value)}
                        placeholder="Leave empty to use default template, or enter custom template with {{variables}}..."
                        sx={{ fontFamily: 'monospace', fontSize: 'sm' }}
                        data-testid="highlights-prompt-template"
                      />
                      <FormHelperText>
                        Custom template for generating weekly highlights. Uses Handlebars syntax. Leave empty to use the
                        default template.
                      </FormHelperText>
                    </FormControl>

                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Typography level="body-sm" color={promptTemplate.length > 9500 ? 'danger' : 'neutral'}>
                        {promptTemplate.length > 0
                          ? `${promptTemplate.length} / 10,000 characters`
                          : 'Using default template'}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        <Button
                          size="sm"
                          variant="outlined"
                          color="neutral"
                          onClick={() => setShowDefaultTemplate(true)}
                          startDecorator={<CodeIcon />}
                          data-testid="highlights-view-default-btn"
                        >
                          View Default Template
                        </Button>
                        <Button
                          size="sm"
                          variant="outlined"
                          color="primary"
                          onClick={() => highlightsPreviewMutation.mutate(promptTemplate || undefined)}
                          loading={highlightsPreviewMutation.isPending}
                          startDecorator={<VisibilityIcon />}
                          data-testid="highlights-preview-prompt-btn"
                        >
                          Preview LLM Prompt
                        </Button>
                        {promptTemplate && (
                          <Button
                            size="sm"
                            variant="outlined"
                            color="neutral"
                            onClick={() => handleFieldChange(setPromptTemplate, '' as string)}
                            data-testid="highlights-clear-template-btn"
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
                        loading={updateConfig.isPending}
                        onClick={handleSave}
                        startDecorator={<SaveIcon />}
                        data-testid="highlights-save-btn"
                      >
                        Save
                      </Button>
                    </Box>
                  </Stack>
                </AccordionDetails>
              </Accordion>
            </AccordionGroup>
          </>
        )}
      </Box>

      {/* Preview Modal */}
      <Modal open={showPreview} onClose={() => setShowPreview(false)}>
        <ModalDialog
          aria-labelledby="highlights-preview-title"
          data-testid="highlights-preview-dialog"
          sx={{ width: '90%', maxWidth: 800, maxHeight: '80vh', overflow: 'auto' }}
        >
          <ModalClose />
          <Typography id="highlights-preview-title" level="h4" sx={{ mb: 2 }}>
            Last Generated Highlights
          </Typography>
          <Divider sx={{ mb: 2 }} />
          <Box
            sx={{
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
              fontSize: 'sm',
              p: 2,
              bgcolor: 'background.level1',
              borderRadius: 'sm',
              overflow: 'auto',
            }}
          >
            {configData?.lastHighlights || 'No highlights available'}
          </Box>
        </ModalDialog>
      </Modal>

      {/* Default Template Modal */}
      <Modal open={showDefaultTemplate} onClose={() => setShowDefaultTemplate(false)}>
        <ModalDialog
          aria-labelledby="default-template-title"
          data-testid="highlights-default-template-dialog"
          sx={{
            width: '90%',
            maxWidth: 900,
            maxHeight: '90vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ModalClose />
          <Typography id="default-template-title" level="h4" sx={{ mb: 1 }}>
            Default Prompt Template
          </Typography>
          <Alert variant="outlined" color="neutral" sx={{ mb: 2 }}>
            <Typography level="body-sm">
              This is the default template used when no custom template is specified. You can copy it and modify for
              your needs.
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
              {getDefaultHighlightsTemplate()}
            </Typography>
          </Sheet>
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between', gap: 1 }}>
            <Button
              variant="outlined"
              startDecorator={<ContentCopyIcon />}
              onClick={() => {
                navigator.clipboard.writeText(getDefaultHighlightsTemplate());
                toast.success('Default template copied to clipboard');
              }}
              data-testid="highlights-copy-default-btn"
            >
              Copy Template
            </Button>
            <Button onClick={() => setShowDefaultTemplate(false)}>Close</Button>
          </Box>
        </ModalDialog>
      </Modal>

      {/* Preview LLM Prompt Modal */}
      <Modal open={highlightsPreviewOpen} onClose={() => setHighlightsPreviewOpen(false)}>
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
            Preview LLM Prompt
          </Typography>
          <Alert variant="outlined" color="primary" sx={{ mb: 2 }}>
            <Typography level="body-sm">
              This is the prompt that will be sent to the LLM, rendered with sample data. Use it to verify your template
              produces the expected output.
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
              {highlightsPreviewContent}
            </Typography>
          </Sheet>
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between', gap: 1 }}>
            <Button
              variant="outlined"
              startDecorator={<ContentCopyIcon />}
              onClick={() => {
                navigator.clipboard.writeText(highlightsPreviewContent);
                toast.success('Prompt copied to clipboard');
              }}
            >
              Copy Prompt
            </Button>
            <Button onClick={() => setHighlightsPreviewOpen(false)}>Close</Button>
          </Box>
        </ModalDialog>
      </Modal>

      {/* Highlights Action Modal (Dry Run / Run Now) */}
      <Modal open={highlightsModalOpen} onClose={() => setHighlightsModalOpen(false)}>
        <ModalDialog sx={{ maxWidth: 500 }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 1 }}>
            {highlightsDryRun ? 'Dry Run — Weekly Highlights' : 'Run Weekly Highlights Now?'}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 2 }}>
            {highlightsDryRun
              ? 'Preview which modals would be included without posting to Slack.'
              : 'Generate highlights from modals in the date range and post them to Slack.'}
          </Typography>
          <Stack spacing={2}>
            <Stack direction="row" spacing={2}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Start Date</FormLabel>
                <Input
                  type="date"
                  value={highlightsStartDate}
                  onChange={e => setHighlightsStartDate(e.target.value)}
                  data-testid="highlights-start-date"
                />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>End Date</FormLabel>
                <Input
                  type="date"
                  value={highlightsEndDate}
                  onChange={e => setHighlightsEndDate(e.target.value)}
                  data-testid="highlights-end-date"
                />
              </FormControl>
            </Stack>
            {!highlightsDryRun && (
              <Alert color="warning" variant="outlined">
                <Typography level="body-sm">This will post highlights to Slack!</Typography>
              </Alert>
            )}

            {/* Dry run results */}
            {highlightsResult && (
              <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm', maxHeight: 300, overflow: 'auto' }}>
                <Typography level="title-sm" sx={{ mb: 1 }}>
                  Results: {highlightsResult.modalCount ?? 0} modal{highlightsResult.modalCount !== 1 ? 's' : ''} found
                </Typography>
                {highlightsResult.dateRange && (
                  <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1 }}>
                    Range: {highlightsResult.dateRange.startDate} to {highlightsResult.dateRange.endDate}
                  </Typography>
                )}
                {highlightsResult.modals && highlightsResult.modals.length > 0 ? (
                  <Stack spacing={1}>
                    {highlightsResult.modals.map((modal, i) => (
                      <Box key={i} sx={{ pl: 1, borderLeft: '2px solid', borderColor: 'primary.300' }}>
                        <Typography level="body-sm" fontWeight="bold">
                          {modal.title}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                          {modal.subtitle} • {new Date(modal.createdAt).toLocaleDateString()}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                ) : (
                  <Alert variant="outlined" color="warning" size="sm">
                    No modals found in this date range. Generation would result in &quot;no_modals&quot; status.
                  </Alert>
                )}
              </Sheet>
            )}

            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Button variant="plain" color="neutral" onClick={() => setHighlightsModalOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="solid"
                color={highlightsDryRun ? 'primary' : 'success'}
                startDecorator={generateHighlights.isPending ? <CircularProgress size="sm" /> : <PlayArrowIcon />}
                onClick={handleHighlightsSubmit}
                disabled={!highlightsStartDate || !highlightsEndDate || generateHighlights.isPending}
              >
                {highlightsDryRun ? 'Run Dry Test' : 'Run Now'}
              </Button>
            </Box>
          </Stack>
        </ModalDialog>
      </Modal>
    </Card>
  );
}
