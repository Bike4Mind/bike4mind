import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
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
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import { FieldTooltip } from '@client/app/components/help';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ErrorIcon from '@mui/icons-material/Error';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CodeIcon from '@mui/icons-material/Code';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AnnouncementIcon from '@mui/icons-material/Announcement';
import SaveIcon from '@mui/icons-material/Save';
import { IModalDocument } from '@bike4mind/common';
import { useLiveOpsTriageEnv } from '@client/app/hooks/data/admin';
import {
  useGetWhatsNewModals,
  useDeleteWhatsNewModal,
  useToggleWhatsNewModal,
  useCreateWhatsNewModal,
  useUpdateWhatsNewModal,
  useGetHighlightsConfig,
  useUpdateHighlightsConfig,
  useGenerateHighlights,
  useGetRawModalVariants,
  useUpdateWhatsNewModalVariants,
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
  shouldShowWeeklyHighlights,
} from './AdminWhatsNewModalsTab.utils';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import {
  HIGHLIGHTS_TEMPLATE_VARIABLES,
  getDefaultHighlightsTemplate,
} from '@bike4mind/server-utils/whatsNew/whatsNewHighlights.prompt';
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
 * - Active modals section (hand-authored What's New modals)
 * - Weekly highlights to Slack
 */
export default function AdminWhatsNewModalsTab() {
  // isForkProduction distinguishes a fork's production stage from the source deployment. The
  // highlights card stays on the main environments only (source prod, dev, PR previews).
  const { data: env } = useLiveOpsTriageEnv();
  const stage = env?.stage || 'unknown';
  const isForkProduction = env?.isForkProduction ?? false;

  // Determine chip color based on environment type
  const getChipColor = () => {
    if (isForkProduction) return 'warning';
    return 'success';
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
              Manage the hand-authored What&apos;s New modals shown in the app. Release notes are managed in the
              Release Notes tab.
            </Typography>
            <Chip size="sm" variant="outlined" color={getChipColor()} sx={{ mt: 1 }}>
              Environment: {stage}
              {isForkProduction && ' (Fork)'}
            </Chip>
          </Box>

          {/* What's New Modals - ALWAYS visible (primary content) */}
          <ActiveModalsCard />

          {/* Weekly Highlights to Slack - only for main environments (production, dev, or PR previews), not forks */}
          {shouldShowWeeklyHighlights(env) && <WeeklyHighlightsCard />}
        </Stack>
      </Box>
    </ErrorBoundary>
  );
}

/**
 * Active modals section showing local What's New modals.
 */
function ActiveModalsCard() {
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
            No What&apos;s New modals found. Create one to announce a change in the app.
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
    skipped?: boolean;
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
      case 'skipped':
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
        return 'No release notes found';
      case 'skipped':
        return 'Skipped: release notes disabled';
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
          Automatically generate weekly highlights from published release notes and post them to a Slack channel. Runs
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
              ? 'Preview which release notes would be included without posting to Slack.'
              : 'Generate highlights from release notes in the date range and post them to Slack.'}
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
                  Results: {highlightsResult.modalCount ?? 0} release note{highlightsResult.modalCount !== 1 ? 's' : ''}{' '}
                  found
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
                    {highlightsResult.skipped
                      ? 'Release notes are disabled, so generation would be skipped.'
                      : 'No release notes were published in this date range. Generation would post a warning instead.'}
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
