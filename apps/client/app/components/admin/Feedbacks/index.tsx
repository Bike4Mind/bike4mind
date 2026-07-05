import React from 'react';
import {
  Card,
  Grid,
  Sheet,
  Stack,
  FormControl,
  Chip,
  LinearProgress,
  Tooltip,
  Checkbox,
  Input,
  Typography,
  Box,
  Select,
  Option,
  IconButton,
  Dropdown,
  MenuButton,
  Menu,
  MenuItem,
} from '@mui/joy';

import { FeedbackStatus } from '@bike4mind/common';

import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import DownloadIcon from '@mui/icons-material/Download';
import FeedbackIcon from '@mui/icons-material/Feedback';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import Papa from 'papaparse';
import PaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';

import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useFeedbackOperations } from './hooks/useFeedbackOperations';
import { useFeedbackFilters } from './hooks/useFeedbackFilters';
import { useFeedbackPagination } from './hooks/useFeedbackPagination';

const FeedbackTab: React.FC = () => {
  const isMobile = useIsMobile();
  const {
    feedback,
    organizations,
    loading,
    refreshFeedback,
    handleStatusChange,
    handleDeleteFeedbackClick,
    confirmDeleteFeedback,
    openDeleteFeedbackModal,
    toggleDeleteFeedbackModal,
  } = useFeedbackOperations();

  const {
    filters,
    setSearchTerm,
    setStatusFilters,
    setSelectedOrganizations,
    toggleSortDirection,
    filteredAndSortedFeedback,
  } = useFeedbackFilters(feedback);

  const { currentPage, currentFeedback, totalPages, handlePageChange, itemsPerPage, handleItemsPerPageChange } =
    useFeedbackPagination(filteredAndSortedFeedback);

  const statusOptions = [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed];

  const handleExportToCSV = () => {
    const csvData = filteredAndSortedFeedback.map(feedbackItem => ({
      ID: feedbackItem._id,
      Status: feedbackItem.status,
      Username: feedbackItem.username,
      Content: feedbackItem.content,
      Organization: feedbackItem.organization,
      UpdatedAt: feedbackItem.updatedAt,
    }));

    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `feedback_${new Date().toISOString().slice(0, 10)}.csv`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getOrganizationDisplayLabel = () => {
    const selected = filters.selectedOrganizations || [];

    if (selected.length === 0) {
      return 'All Organizations';
    }

    if (selected.length === 1) {
      return selected[0];
    }

    return `${selected.length} Selected`;
  };

  const toggleOrganization = (orgName: string) => {
    const currentSelection = filters.selectedOrganizations || [];

    if (orgName === 'all') {
      setSelectedOrganizations([]);
    } else {
      if (currentSelection.includes(orgName)) {
        setSelectedOrganizations(currentSelection.filter(org => org !== orgName));
      } else {
        setSelectedOrganizations([...currentSelection, orgName]);
      }
    }
  };

  return (
    <Sheet sx={{ overflow: 'hidden', width: '100%', px: { xs: 1, sm: 2 } }}>
      <Grid container>
        <Grid xs={12}>
          <Stack direction="column" justifyContent={'center'} spacing={1} sx={{ width: '100%' }}>
            <Stack direction="column" spacing={1} sx={{ mb: 3, pt: 1 }}>
              {/* Unified Control Panel */}
              <Card>
                <Stack spacing={1.5}>
                  {/* Row 1: Search + Organizations side by side */}
                  <Stack direction={{ xs: 'row', sm: 'row' }} spacing={1}>
                    <FormControl sx={{ flex: 1 }}>
                      <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                        Search
                      </Typography>
                      <Input
                        startDecorator={<FeedbackIcon />}
                        placeholder="Search feedback..."
                        value={filters.searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                      />
                    </FormControl>

                    <FormControl sx={{ flex: 1 }}>
                      <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                        Organizations
                      </Typography>
                      <Dropdown>
                        <MenuButton
                          disabled={loading}
                          endDecorator={<KeyboardArrowDownIcon />}
                          sx={{ justifyContent: 'space-between', textAlign: 'left', fontWeight: 'normal' }}
                        >
                          <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {getOrganizationDisplayLabel()}
                          </Box>
                        </MenuButton>
                        <Menu sx={{ maxHeight: 300, overflowY: 'auto', minWidth: 200 }}>
                          <MenuItem onClick={() => toggleOrganization('all')}>
                            <Checkbox
                              checked={filters.selectedOrganizations.length === 0}
                              onChange={() => toggleOrganization('all')}
                              sx={{ mr: 1 }}
                            />
                            All
                          </MenuItem>
                          {organizations.map(org => (
                            <MenuItem key={org} onClick={() => toggleOrganization(org)}>
                              <Checkbox
                                checked={filters.selectedOrganizations.includes(org)}
                                onChange={() => toggleOrganization(org)}
                                sx={{ mr: 1 }}
                              />
                              {org}
                            </MenuItem>
                          ))}
                        </Menu>
                      </Dropdown>
                    </FormControl>
                  </Stack>

                  {/* Row 2: Status filters + Action buttons */}
                  <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
                    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
                      {Object.entries(filters.statusFilters).map(([status, isChecked]) => (
                        <Checkbox
                          key={status}
                          checked={isChecked}
                          onChange={() => {
                            setStatusFilters(currentFilters => ({
                              ...currentFilters,
                              [status as keyof typeof currentFilters]:
                                !currentFilters[status as keyof typeof currentFilters],
                            }));
                          }}
                          label={status}
                          size="sm"
                        />
                      ))}
                    </Stack>

                    <Stack direction="row" spacing={1} alignItems="center">
                      <ContextHelpButton helpId="admin/feedbacks" tooltipText="Feedbacks Help" />
                      <Tooltip title="Refresh">
                        <IconButton disabled={loading} onClick={refreshFeedback} variant="outlined" size="sm">
                          <RefreshIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Export CSV">
                        <IconButton
                          disabled={loading || filteredAndSortedFeedback.length === 0}
                          onClick={handleExportToCSV}
                          color="success"
                          variant="outlined"
                          size="sm"
                        >
                          <DownloadIcon />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                </Stack>
              </Card>
            </Stack>
          </Stack>
        </Grid>

        <Grid xs={12} mb={0.5} pb={0.7} sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
          <PaginationControls
            currentPage={currentPage}
            onPageChange={handlePageChange}
            totalPages={totalPages}
            totalItems={filteredAndSortedFeedback.length}
            itemsPerPage={itemsPerPage}
            onItemsPerPageChange={handleItemsPerPageChange}
          />
        </Grid>

        {loading && <LinearProgress size={'lg'} sx={{ marginX: '5px', width: '100%' }} />}

        {openDeleteFeedbackModal && (
          <ConfirmActionModal
            title="Delete Feedback"
            description="Are you sure you want to delete this feedback? This action cannot be undone."
            onGoBackward={toggleDeleteFeedbackModal}
            onGoForward={confirmDeleteFeedback}
            disabledConfirm={loading}
          />
        )}

        {!loading && (
          <Grid xs={12} mt={0.5}>
            <Sheet sx={{ width: '100%' }}>
              {/* Scrollable Feedback Rows */}
              <Sheet sx={{ overflowY: 'auto', maxHeight: '70vh', width: '100%' }}>
                {/* Header Row - hidden on mobile */}
                <Box
                  sx={{
                    mb: 1,
                    position: 'sticky',
                    top: 0,
                    bgcolor: 'background.surface',
                    zIndex: 1,
                    overflowX: { xs: 'auto', sm: 'visible' },
                    display: { xs: 'none', sm: 'block' },
                  }}
                >
                  <Grid
                    container
                    xs={12}
                    md={12}
                    sm={12}
                    sx={{ px: 0.5, py: 1, minWidth: { xs: '600px', sm: 'auto' } }}
                  >
                    <Grid xs={2} display={'flex'}>
                      <Typography
                        sx={{
                          color: 'primary',
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          '&:hover': { textDecoration: 'underline' },
                        }}
                        level="body-sm"
                        onClick={toggleSortDirection}
                      >
                        Created At {filters.sortAscending ? '↑' : '↓'}
                      </Typography>
                    </Grid>
                    <Grid xs={2.5}>
                      <Typography sx={{ color: 'primary', fontWeight: 600 }} level="body-sm">
                        Reporter
                      </Typography>
                    </Grid>
                    <Grid xs={5.5}>
                      <Typography sx={{ color: 'primary', fontWeight: 600 }} level="body-sm">
                        Feedback
                      </Typography>
                    </Grid>
                    <Grid xs={2}>
                      <Typography sx={{ color: 'primary', fontWeight: 600 }} level="body-sm">
                        Actions
                      </Typography>
                    </Grid>
                  </Grid>
                </Box>
                {currentFeedback.map((feedbackItem, index) =>
                  isMobile ? (
                    <Card
                      variant="outlined"
                      key={feedbackItem._id}
                      sx={{ mb: 1, bgcolor: index % 2 ? 'background.level1' : 'background.level2', p: 1.5 }}
                    >
                      <Stack spacing={1}>
                        {/* Date + Actions row */}
                        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                          <Stack spacing={0.25}>
                            <Typography level="body-xs">
                              {new Date(feedbackItem.createdAt).toLocaleString('default', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: true,
                              })}
                            </Typography>
                            <Typography level="body-xs">
                              {relativeTimeFormat(new Date(feedbackItem.createdAt))}
                            </Typography>
                            <Stack direction="row" flexWrap="wrap" gap={0.2}>
                              {feedbackItem.tags?.map((tag, tagIndex) => (
                                <Chip key={tagIndex} color="success" size="sm" sx={{ borderRadius: '10px' }}>
                                  <Typography level="body-xs">{tag}</Typography>
                                </Chip>
                              ))}
                            </Stack>
                          </Stack>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Select
                              value={feedbackItem.status}
                              onChange={(_, newValue) => handleStatusChange(feedbackItem, newValue)}
                              size="sm"
                              sx={{ minWidth: '100px' }}
                            >
                              {statusOptions.map(status => (
                                <Option key={status} value={status}>
                                  {status}
                                </Option>
                              ))}
                            </Select>
                            <Tooltip title="Delete" color="danger">
                              <IconButton
                                size="sm"
                                color="danger"
                                onClick={() => handleDeleteFeedbackClick(feedbackItem)}
                              >
                                <DeleteForeverIcon />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </Stack>
                        {/* Reporter */}
                        <Stack spacing={0.1} sx={{ wordWrap: 'break-word' }}>
                          {feedbackItem.organization && feedbackItem.organization !== 'Unknown' && (
                            <Typography fontWeight="600" level="body-sm">
                              {feedbackItem.organization}
                            </Typography>
                          )}
                          {feedbackItem.username && <Typography level="body-sm">{feedbackItem.username}</Typography>}
                          {feedbackItem.userEmail && (
                            <Typography level="body-xs" sx={{ fontStyle: 'italic' }}>
                              {feedbackItem.userEmail}
                            </Typography>
                          )}
                        </Stack>
                        {/* Content */}
                        <Typography
                          level="body-sm"
                          sx={{
                            overflowY: 'auto',
                            wordWrap: 'break-word',
                            whiteSpace: 'pre-wrap',
                            maxHeight: '100px',
                            scrollbarWidth: 'thin',
                          }}
                        >
                          {feedbackItem.content}
                        </Typography>
                      </Stack>
                    </Card>
                  ) : (
                    <Card
                      variant="outlined"
                      key={feedbackItem._id}
                      sx={{
                        mb: 1,
                        bgcolor: index % 2 ? 'background.level1' : 'background.level2',
                        py: 1,
                        px: 0.5,
                        overflowX: { xs: 'auto', sm: 'visible' },
                      }}
                    >
                      <Grid
                        container
                        xs={12}
                        display={'flex'}
                        spacing={1.5}
                        sx={{ minWidth: { xs: '600px', sm: 'auto' } }}
                      >
                        <Grid xs={2} sx={{ maxWidth: '100%', overflow: 'hidden' }}>
                          <Stack>
                            <Stack
                              direction="column"
                              sx={{
                                mb: '3px',
                                gap: 0.2,
                                flexWrap: 'wrap',
                                maxWidth: '100%',
                              }}
                            >
                              <Stack direction="column" sx={{ ml: 0.5, mb: 0.2, flexWrap: 'wrap', maxWidth: '100%' }}>
                                <Typography level="body-xs">
                                  {new Date(feedbackItem.createdAt).toLocaleString('default', {
                                    year: 'numeric',
                                    month: 'short',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: true,
                                  })}
                                </Typography>
                                <Typography level="body-xs">
                                  {relativeTimeFormat(new Date(feedbackItem.createdAt))}
                                </Typography>
                              </Stack>
                              <Stack direction="row" sx={{ flexWrap: 'wrap', maxWidth: '100%', gap: 0.2 }}>
                                {feedbackItem.tags &&
                                  feedbackItem.tags.map((tag, tagIndex) => (
                                    <Chip key={tagIndex} color="success" size="sm" sx={{ borderRadius: '10px' }}>
                                      <Typography level="body-xs" sx={{ overflowX: 'hidden', width: 'auto' }}>
                                        {tag}
                                      </Typography>
                                    </Chip>
                                  ))}
                              </Stack>
                            </Stack>
                          </Stack>
                        </Grid>
                        <Grid xs={2.5}>
                          <Stack direction={'column'} sx={{ wordWrap: 'break-word' }}>
                            {feedbackItem.organization && feedbackItem.organization !== 'Unknown' && (
                              <Tooltip title="Company">
                                <Typography fontWeight={'600'} level="body-sm">
                                  {feedbackItem.organization}
                                </Typography>
                              </Tooltip>
                            )}
                            {feedbackItem.username && (
                              <Tooltip title="User Name">
                                <Typography level="body-sm">{feedbackItem.username}</Typography>
                              </Tooltip>
                            )}
                            {feedbackItem.userEmail && (
                              <Tooltip title={feedbackItem.userId}>
                                <Typography level="body-xs" sx={{ fontStyle: 'italic' }}>
                                  {feedbackItem.userEmail}
                                </Typography>
                              </Tooltip>
                            )}
                          </Stack>
                        </Grid>
                        <Grid xs={5.5}>
                          <Typography
                            level="body-sm"
                            sx={{
                              overflowY: 'auto',
                              overflowX: 'hidden',
                              wordWrap: 'break-word',
                              whiteSpace: 'pre-wrap',
                              maxHeight: '80px',
                              '&::-webkit-scrollbar': {
                                width: '1px',
                                backgroundColor: 'background.level1',
                              },
                              '&::-webkit-scrollbar-thumb': {
                                backgroundColor: 'neutral.400',
                                borderRadius: '1px',
                                '&:hover': {
                                  backgroundColor: 'neutral.500',
                                },
                              },
                              '&::-webkit-scrollbar-track': {
                                backgroundColor: 'background.level1',
                              },
                              scrollbarWidth: 'thin',
                              scrollbarColor: 'var(--joy-palette-neutral-400) var(--joy-palette-background-level1)',
                            }}
                          >
                            {feedbackItem.content}
                          </Typography>
                        </Grid>
                        <Grid xs={2}>
                          <Stack direction={'row'} alignItems={'center'} display={'flex'}>
                            <Select
                              value={feedbackItem.status}
                              onChange={(_, newValue) => {
                                handleStatusChange(feedbackItem, newValue);
                              }}
                              size="sm"
                              sx={{ minWidth: '115px' }}
                            >
                              {statusOptions.map(status => (
                                <Option key={status} value={status}>
                                  {status}
                                </Option>
                              ))}
                            </Select>
                            <Tooltip title="Delete" color="danger">
                              <IconButton
                                size="sm"
                                color="danger"
                                onClick={() => handleDeleteFeedbackClick(feedbackItem)}
                              >
                                <DeleteForeverIcon />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </Grid>
                      </Grid>
                    </Card>
                  )
                )}
              </Sheet>
            </Sheet>
          </Grid>
        )}
      </Grid>
    </Sheet>
  );
};

export default FeedbackTab;
