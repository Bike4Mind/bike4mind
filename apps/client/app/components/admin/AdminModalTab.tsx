import React, { useState, useEffect, useMemo } from 'react';
import {
  Button,
  Card,
  Sheet,
  Tooltip,
  Stack,
  Typography,
  LinearProgress,
  Chip,
  Box,
  IconButton,
  Badge,
  Select,
  Option,
  Input,
  FormControl,
} from '@mui/joy';
import { IModal, IModalDocument } from '@bike4mind/common';

import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import PreviewIcon from '@mui/icons-material/Preview';
import AddIcon from '@mui/icons-material/Add';
import Table from '@mui/joy/Table';
import PowerIcon from '@mui/icons-material/Power';
import PowerOffIcon from '@mui/icons-material/PowerOff';
import CampaignIcon from '@mui/icons-material/Campaign';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import PriorityHighIcon from '@mui/icons-material/PriorityHigh';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SearchIcon from '@mui/icons-material/Search';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FirstPageIcon from '@mui/icons-material/FirstPage';
import LastPageIcon from '@mui/icons-material/LastPage';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';

import { deleteModalFromServer, updateModal, createModal } from '@client/app/utils/modalsAPICalls';

import { toast } from 'sonner';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

import GenericModal from '@client/app/components/modals/GenericModal';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { useGetModals } from '@client/app/hooks/data/modals';
import { useQueryClient } from '@tanstack/react-query';
import { useGetPresignedUrl } from '@client/app/hooks/data/fabFiles';

import EditModalNew from './AdminModalTabNew';

interface ModalActionButtonsProps {
  modal: IModalDocument;
  onEdit: (modal: IModalDocument) => void;
  onPreview: (modal: IModalDocument) => void;
  onDelete: (modal: IModalDocument) => void;
}

const ModalActionButtons: React.FC<ModalActionButtonsProps> = ({ modal, onEdit, onPreview, onDelete }) => (
  <Stack direction="row" spacing={0} justifyContent="center">
    <Tooltip title="Edit">
      <IconButton size="sm" variant="plain" color="primary" onClick={() => onEdit(modal)}>
        <EditIcon />
      </IconButton>
    </Tooltip>
    <Tooltip title="Preview">
      <IconButton size="sm" variant="plain" color="success" onClick={() => onPreview(modal)}>
        <PreviewIcon />
      </IconButton>
    </Tooltip>
    <Tooltip title="Delete">
      <IconButton size="sm" variant="plain" color="danger" onClick={() => onDelete(modal)}>
        <DeleteIcon />
      </IconButton>
    </Tooltip>
  </Stack>
);

const ModalsAdminTab: React.FC = () => {
  const isMobile = useIsMobile();
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [currentModal, setCurrentModal] = useState<IModalDocument | null>(null);
  const [previewModalData, setPreviewModalData] = useState<IModal | null>(null);
  const [previewData, setPreviewData] = useState<IModal | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState<boolean>(false);
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);
  const [modalToDelete, setModalToDelete] = useState<IModalDocument | null>(null);

  // Pagination and search states
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortColumn, setSortColumn] = useState<'title' | 'type' | 'priority' | 'createdAt' | 'updatedAt' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Exclude What's New modals since they have their own dedicated admin tab
  const modals = useGetModals({ excludeWhatsNew: true });
  const queryClient = useQueryClient();
  const { mutateAsync: getPresignedUrl } = useGetPresignedUrl();

  const handleSort = (column: 'title' | 'type' | 'priority' | 'createdAt' | 'updatedAt') => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const filteredAndSortedModals = useMemo(() => {
    if (!modals.data) return [];

    const filtered = modals.data.filter(modal => {
      const searchLower = searchQuery.toLowerCase();
      return (
        modal.title?.toLowerCase().includes(searchLower) ||
        '' ||
        modal.textMessage?.toLowerCase().includes(searchLower) ||
        '' ||
        modal.description?.toLowerCase().includes(searchLower) ||
        '' ||
        modal.tags?.some(tag => tag.toLowerCase().includes(searchLower)) ||
        false
      );
    });

    if (sortColumn) {
      filtered.sort((a, b) => {
        let aValue: any;
        let bValue: any;

        switch (sortColumn) {
          case 'title':
            aValue = a.isBanner ? a.textMessage : a.title;
            bValue = b.isBanner ? b.textMessage : b.title;
            break;
          case 'type':
            aValue = a.isBanner ? 'banner' : 'modal';
            bValue = b.isBanner ? 'banner' : 'modal';
            break;
          case 'priority':
            aValue = a.priority || 0;
            bValue = b.priority || 0;
            break;
          case 'createdAt':
            aValue = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            bValue = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            break;
          case 'updatedAt':
            aValue = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            bValue = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            break;
          default:
            return 0;
        }

        let comparison: number;
        if (typeof aValue === 'string' && typeof bValue === 'string') {
          comparison = aValue.localeCompare(bValue);
        } else {
          comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
        }

        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }

    return filtered;
  }, [modals.data, searchQuery, sortColumn, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAndSortedModals.length / rowsPerPage);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const paginatedModals = filteredAndSortedModals.slice(startIndex, endIndex);

  // Reset to first page when search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  const handlePageChange = (page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  };

  const handleRowsPerPageChange = (value: number) => {
    setRowsPerPage(value);
    setCurrentPage(1);
  };

  // Handle async preview data generation
  useEffect(() => {
    const generatePreviewData = async () => {
      if (!previewModalData) {
        setPreviewData(null);
        return;
      }

      try {
        const imageUrl = previewModalData.imageUrl;

        if (imageUrl && imageUrl.includes('amazonaws.com') && !imageUrl.includes('/proxied-images/')) {
          const urlObj = new URL(imageUrl);
          const filePath = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
          const [presignedUrl] = await getPresignedUrl({ filePaths: [filePath], expiresIn: 3600 });

          setPreviewData({ ...previewModalData, imageUrl: presignedUrl });
        } else {
          setPreviewData(previewModalData);
        }
      } catch (e) {
        setPreviewData(previewModalData);
      }
    };

    generatePreviewData();
  }, [previewModalData, getPresignedUrl]);

  const handleDeleteConfirmed = async () => {
    if (modalToDelete && modalToDelete._id) {
      try {
        await deleteModalFromServer(modalToDelete._id);
        toast.success('Modal deleted successfully');
        queryClient.invalidateQueries({ queryKey: ['modals'] });
      } catch (error) {
        console.error('Error deleting modal:', error);
        toast.error('Failed to delete modal');
      }
    }
    setModalToDelete(null);
    setIsConfirmDeleteOpen(false);
  };

  const handleToggleModalProperty = async (modal: IModalDocument, property: 'enabled' | 'isBanner') => {
    try {
      const updatedModal = { ...modal, [property]: !modal[property] };
      if (modal._id) {
        await updateModal(modal._id, updatedModal);
        toast.success(`Modal ${property} ${updatedModal[property] ? 'enabled' : 'disabled'} successfully`);
        queryClient.invalidateQueries({ queryKey: ['modals'] });
      }
    } catch (error) {
      console.error('Error updating modal %s:', property, error);
      toast.error(`Failed to update modal ${property}`);
    }
  };

  const handleSaveModal = async (modalFields: IModal) => {
    try {
      if (!modalFields.numberOfAgrees?.type || !modalFields.numberOfViews?.type) {
        toast.error('Please setup the number of agrees and number of views counters before creating the modal.');
        return;
      }

      if (currentModal && currentModal._id) {
        await updateModal(currentModal._id, modalFields);
        toast.success('Modal updated successfully');
      } else {
        await createModal(modalFields);
        toast.success('Modal created successfully');
      }

      queryClient.invalidateQueries({ queryKey: ['modals'] });
      setIsEditModalOpen(false);
    } catch (error) {
      console.error('Error saving modal:', error);
      toast.error('Failed to save modal');
    }
  };

  const handleEditClick = (modal: IModalDocument) => {
    setCurrentModal(modal);
    setIsEditModalOpen(true);
  };

  const handlePreviewClick = (modal: IModalDocument) => {
    setPreviewData({ ...modal, imageUrl: '' });
    setPreviewModalData(modal);
    setIsPreviewOpen(true);
  };

  const handleDeleteClick = (modal: IModalDocument) => {
    setModalToDelete(modal);
    setIsConfirmDeleteOpen(true);
  };

  return (
    <Sheet sx={{ p: 2, width: '100%', overflow: 'auto' }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="h2">Modals Management</Typography>
          <ContextHelpButton helpId="admin/modals" tooltipText="Modals Help" />
        </Stack>
        <Button
          startDecorator={<AddIcon />}
          onClick={() => {
            setCurrentModal(null);
            setIsEditModalOpen(true);
          }}
          color="primary"
          variant="solid"
          sx={{ width: { xs: '100%', sm: 'auto' } }}
        >
          Create New Modal
        </Button>
      </Stack>

      {/* Search Bar */}
      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <FormControl sx={{ flex: 1 }}>
          <Input
            placeholder="Search modals by title, message, description, or tags..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            startDecorator={<SearchIcon />}
            sx={{ width: '100%' }}
          />
        </FormControl>
      </Stack>

      {modals.isFetching && <LinearProgress />}

      {(!modals.data || modals.data.length === 0) && !modals.isFetching ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            py: 8,
            px: 2,
            bgcolor: 'background.level1',
            borderRadius: 'lg',
            border: '2px dashed',
            borderColor: 'divider',
          }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 64, color: 'primary.300', mb: 2 }} />
          <Typography level="h3" sx={{ mb: 1 }}>
            No Modals Yet
          </Typography>
          <Typography level="body-md" sx={{ mb: 3, color: 'text.secondary', textAlign: 'center' }}>
            Create your first modal or banner to engage with your users
          </Typography>
          <Button
            size="lg"
            startDecorator={<AddIcon />}
            onClick={() => {
              setCurrentModal(null);
              setIsEditModalOpen(true);
            }}
            sx={{
              background: 'linear-gradient(45deg, #2196F3 30%, #21CBF3 90%)',
              boxShadow: '0 3px 5px 2px rgba(33, 203, 243, .3)',
            }}
          >
            Create Your First Modal
          </Button>
        </Box>
      ) : isMobile ? (
        <Stack spacing={1}>
          {paginatedModals.map(modal => (
            <Card key={modal._id?.toString() ?? 'unknown'} variant="outlined" sx={{ p: 1.5 }}>
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                  <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0, mr: 0.5 }}>
                    <Typography level="title-sm" fontWeight="lg" noWrap>
                      {modal.title || '(No title)'}
                    </Typography>
                    {modal.isBanner && modal.textMessage && (
                      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                        {modal.textMessage}
                      </Typography>
                    )}
                    {!modal.isBanner && modal.subtitle && (
                      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                        {modal.subtitle}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={0.5} flexWrap="wrap">
                      <Chip
                        size="sm"
                        variant="soft"
                        color={modal.isBanner ? 'warning' : 'primary'}
                        startDecorator={modal.isBanner ? <CampaignIcon /> : <NotificationsActiveIcon />}
                      >
                        {modal.isBanner ? 'Banner' : 'Modal'}
                      </Chip>
                      {modal.priority > 0 && (
                        <Chip size="sm" variant="soft" color={modal.priority >= 5 ? 'danger' : 'primary'}>
                          P{modal.priority}
                        </Chip>
                      )}
                    </Stack>
                  </Stack>
                  <Stack direction="row" spacing={0.25} alignItems="center" sx={{ flexShrink: 0 }}>
                    <ModalActionButtons
                      modal={modal}
                      onEdit={handleEditClick}
                      onPreview={handlePreviewClick}
                      onDelete={handleDeleteClick}
                    />
                    <Tooltip title={modal.enabled ? 'Active - Click to disable' : 'Inactive - Click to enable'}>
                      <IconButton
                        size="sm"
                        variant={modal.enabled ? 'solid' : 'outlined'}
                        color={modal.enabled ? 'success' : 'neutral'}
                        onClick={() => handleToggleModalProperty(modal, 'enabled')}
                        sx={{ borderRadius: '50%' }}
                      >
                        {modal.enabled ? <PowerIcon /> : <PowerOffIcon />}
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>
                {modal.description && (
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    {modal.description}
                  </Typography>
                )}
                {modal.tags && modal.tags.length > 0 && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {modal.tags.slice(0, 2).map(tag => (
                      <Chip key={tag} size="sm" variant="outlined" color="neutral">
                        {tag}
                      </Chip>
                    ))}
                    {modal.tags.length > 2 && (
                      <Chip size="sm" variant="soft" color="neutral">
                        +{modal.tags.length - 2}
                      </Chip>
                    )}
                  </Box>
                )}
                <Stack direction="row" spacing={1}>
                  {modal.createdAt && (
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      Created:{' '}
                      {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
                        new Date(modal.createdAt)
                      )}
                    </Typography>
                  )}
                </Stack>
              </Stack>
            </Card>
          ))}
        </Stack>
      ) : (
        <Table
          aria-label="Modals table"
          stickyHeader
          hoverRow
          sx={{
            '& thead th': {
              bgcolor: 'background.level2',
              fontWeight: 'lg',
              borderBottom: '2px solid',
              borderColor: 'divider',
            },
            '& tbody tr:hover': {
              bgcolor: 'background.level1',
            },
          }}
        >
          <thead>
            <tr>
              <th style={{ width: '8%', textAlign: 'center' }}>Status</th>
              <th style={{ width: '7%', textAlign: 'center', cursor: 'pointer' }} onClick={() => handleSort('type')}>
                <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center">
                  Type
                  {sortColumn === 'type' ? (
                    sortDirection === 'asc' ? (
                      <ArrowUpwardIcon fontSize="small" />
                    ) : (
                      <ArrowDownwardIcon fontSize="small" />
                    )
                  ) : (
                    <UnfoldMoreIcon fontSize="small" />
                  )}
                </Stack>
              </th>
              <th style={{ width: '15%', cursor: 'pointer' }} onClick={() => handleSort('title')}>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  Title / Message
                  {sortColumn === 'title' ? (
                    sortDirection === 'asc' ? (
                      <ArrowUpwardIcon fontSize="small" />
                    ) : (
                      <ArrowDownwardIcon fontSize="small" />
                    )
                  ) : (
                    <UnfoldMoreIcon fontSize="small" />
                  )}
                </Stack>
              </th>
              <th style={{ width: '20%' }}>Description</th>
              <th style={{ width: '10%' }}>Targeting</th>
              <th
                style={{ width: '5%', textAlign: 'center', cursor: 'pointer' }}
                onClick={() => handleSort('priority')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center">
                  Priority
                  {sortColumn === 'priority' ? (
                    sortDirection === 'asc' ? (
                      <ArrowUpwardIcon fontSize="small" />
                    ) : (
                      <ArrowDownwardIcon fontSize="small" />
                    )
                  ) : (
                    <UnfoldMoreIcon fontSize="small" />
                  )}
                </Stack>
              </th>
              <th
                style={{ width: '10%', textAlign: 'center', cursor: 'pointer' }}
                onClick={() => handleSort('createdAt')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center">
                  Created
                  {sortColumn === 'createdAt' ? (
                    sortDirection === 'asc' ? (
                      <ArrowUpwardIcon fontSize="small" />
                    ) : (
                      <ArrowDownwardIcon fontSize="small" />
                    )
                  ) : (
                    <UnfoldMoreIcon fontSize="small" />
                  )}
                </Stack>
              </th>
              <th
                style={{ width: '10%', textAlign: 'center', cursor: 'pointer' }}
                onClick={() => handleSort('updatedAt')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center">
                  Updated
                  {sortColumn === 'updatedAt' ? (
                    sortDirection === 'asc' ? (
                      <ArrowUpwardIcon fontSize="small" />
                    ) : (
                      <ArrowDownwardIcon fontSize="small" />
                    )
                  ) : (
                    <UnfoldMoreIcon fontSize="small" />
                  )}
                </Stack>
              </th>
              <th style={{ width: '15%', textAlign: 'center' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedModals.map(modal => (
              <tr key={modal._id}>
                <td>
                  <Stack direction="row" spacing={1} justifyContent="center" alignItems="center">
                    <Tooltip title={modal.enabled ? 'Active - Click to disable' : 'Inactive - Click to enable'}>
                      <IconButton
                        size="sm"
                        variant={modal.enabled ? 'solid' : 'outlined'}
                        color={modal.enabled ? 'success' : 'neutral'}
                        onClick={() => handleToggleModalProperty(modal, 'enabled')}
                        sx={{
                          borderRadius: '50%',
                          transition: 'all 0.2s',
                          '&:hover': { transform: 'scale(1.1)' },
                        }}
                      >
                        {modal.enabled ? <PowerIcon /> : <PowerOffIcon />}
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </td>
                <td>
                  <Stack direction="row" justifyContent="center">
                    <Chip
                      size="sm"
                      variant="soft"
                      color={modal.isBanner ? 'warning' : 'primary'}
                      startDecorator={modal.isBanner ? <CampaignIcon /> : <NotificationsActiveIcon />}
                    >
                      {modal.isBanner ? 'Banner' : 'Modal'}
                    </Chip>
                  </Stack>
                </td>
                <td>
                  <Box>
                    <Typography level="body-sm" fontWeight="lg">
                      {modal.title || '(No title)'}
                    </Typography>
                    {modal.isBanner && modal.textMessage && (
                      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                        {modal.textMessage}
                      </Typography>
                    )}
                    {!modal.isBanner && modal.subtitle && (
                      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                        {modal.subtitle}
                      </Typography>
                    )}
                  </Box>
                </td>
                <td>
                  <Tooltip title={modal.description} arrow placement="top">
                    <Typography
                      level="body-sm"
                      sx={{
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        color: 'text.secondary',
                      }}
                    >
                      {modal.description}
                    </Typography>
                  </Tooltip>
                </td>
                <td>
                  <Stack spacing={0.5}>
                    {modal.tags && modal.tags.length > 0 ? (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {modal.tags.slice(0, 2).map(tag => (
                          <Chip key={tag} size="sm" variant="outlined" color="neutral">
                            {tag}
                          </Chip>
                        ))}
                        {modal.tags.length > 2 && (
                          <Chip size="sm" variant="soft" color="neutral">
                            +{modal.tags.length - 2}
                          </Chip>
                        )}
                      </Box>
                    ) : (
                      <Chip size="sm" variant="soft" color="neutral">
                        All users
                      </Chip>
                    )}
                  </Stack>
                </td>
                <td>
                  <Stack direction="row" justifyContent="center">
                    {modal.priority > 0 ? (
                      <Badge badgeContent={modal.priority} color={modal.priority >= 5 ? 'danger' : 'primary'}>
                        <PriorityHighIcon
                          sx={{ fontSize: 20, color: modal.priority >= 5 ? 'danger.500' : 'primary.500' }}
                        />
                      </Badge>
                    ) : (
                      <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                        0
                      </Typography>
                    )}
                  </Stack>
                </td>
                <td>
                  <Typography level="body-xs" sx={{ textAlign: 'center' }}>
                    {modal.createdAt
                      ? new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        }).format(new Date(modal.createdAt))
                      : '-'}
                  </Typography>
                </td>
                <td>
                  <Typography level="body-xs" sx={{ textAlign: 'center' }}>
                    {modal.updatedAt
                      ? new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        }).format(new Date(modal.updatedAt))
                      : '-'}
                  </Typography>
                </td>
                <td>
                  <ModalActionButtons
                    modal={modal}
                    onEdit={handleEditClick}
                    onPreview={handlePreviewClick}
                    onDelete={handleDeleteClick}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* Pagination Controls */}
      {filteredAndSortedModals.length > 0 && (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          justifyContent="space-between"
          sx={{ mt: 2, px: 1 }}
        >
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Typography level="body-sm">Rows per page:</Typography>
            <Select
              value={rowsPerPage}
              onChange={(_, value) => handleRowsPerPageChange(value as number)}
              size="sm"
              sx={{ minWidth: 70 }}
            >
              <Option value={5}>5</Option>
              <Option value={10}>10</Option>
              <Option value={25}>25</Option>
              <Option value={50}>50</Option>
            </Select>
            <Typography level="body-sm">
              {startIndex + 1}-{Math.min(endIndex, filteredAndSortedModals.length)} of {filteredAndSortedModals.length}{' '}
              modals
            </Typography>
          </Stack>

          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            justifyContent={{ xs: 'space-between', sm: 'flex-end' }}
          >
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => handlePageChange(1)}
              disabled={currentPage === 1}
              aria-label="First page"
            >
              <FirstPageIcon />
            </IconButton>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              aria-label="Previous page"
            >
              <ChevronLeftIcon />
            </IconButton>
            <Typography level="body-sm" sx={{ px: 1, whiteSpace: 'nowrap' }}>
              Page {currentPage} of {totalPages || 1}
            </Typography>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages || totalPages === 0}
              aria-label="Next page"
            >
              <ChevronRightIcon />
            </IconButton>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => handlePageChange(totalPages)}
              disabled={currentPage === totalPages || totalPages === 0}
              aria-label="Last page"
            >
              <LastPageIcon />
            </IconButton>
          </Stack>
        </Stack>
      )}

      {isEditModalOpen && (
        <EditModalNew
          isOpen={isEditModalOpen}
          onClose={() => setIsEditModalOpen(false)}
          modalData={currentModal}
          onSave={handleSaveModal}
          isEditMode={!!currentModal}
        />
      )}

      {isConfirmDeleteOpen && (
        <ConfirmActionModal
          title="Delete Modal"
          description={`Are you sure you want to delete the modal "${modalToDelete?.title}"? This action cannot be undone.`}
          onGoForward={handleDeleteConfirmed}
          onGoBackward={() => setIsConfirmDeleteOpen(false)}
        />
      )}

      {isPreviewOpen && previewData && (
        <GenericModal
          {...previewData}
          isOpen={isPreviewOpen}
          onAgree={() => setIsPreviewOpen(false)}
          onClose={() => setIsPreviewOpen(false)}
          isPreview={true}
        />
      )}
    </Sheet>
  );
};
export default ModalsAdminTab;
