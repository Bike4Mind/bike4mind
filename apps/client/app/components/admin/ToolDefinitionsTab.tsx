import React, { useState, useMemo, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  LinearProgress,
  Modal,
  ModalDialog,
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
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import RestoreIcon from '@mui/icons-material/Restore';
import { toast } from 'sonner';
import {
  useToolDefinitions,
  useUpdateToolDefinition,
  useDeleteToolDefinition,
  type IToolDefinition,
  type ToolDefinitionsFilters,
} from '@client/app/hooks/data/toolDefinitions';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

const PAGE_SIZE = 50;

const ToolDefinitionsTab: React.FC = () => {
  const isMobile = useIsMobile();
  // Filter state
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [enabledFilter, setEnabledFilter] = useState<'true' | 'false' | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  // Modal state
  const [viewingTool, setViewingTool] = useState<IToolDefinition | null>(null);
  const [editingTool, setEditingTool] = useState<IToolDefinition | null>(null);

  // Edit form state
  const [description, setDescription] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [enabled, setEnabled] = useState(true);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [categoryFilter, enabledFilter, debouncedSearch]);

  const filters: ToolDefinitionsFilters = useMemo(
    () => ({
      category: categoryFilter !== 'all' ? categoryFilter : undefined,
      enabled: enabledFilter,
      search: debouncedSearch || undefined,
      page: currentPage,
      limit: PAGE_SIZE,
    }),
    [categoryFilter, enabledFilter, debouncedSearch, currentPage]
  );

  const { data, isLoading, refetch } = useToolDefinitions(filters);
  const updateTool = useUpdateToolDefinition();
  const deleteTool = useDeleteToolDefinition();

  // Initialize edit form when editingTool changes
  useEffect(() => {
    if (editingTool) {
      setDescription(editingTool.description || '');
      setShortDescription(editingTool.shortDescription || '');
      setEnabled(editingTool.enabled ?? true);
    }
  }, [editingTool]);

  // Change detection
  const hasChanges = useMemo(() => {
    if (!editingTool) return false;
    return (
      description !== (editingTool.description ?? '') ||
      shortDescription !== (editingTool.shortDescription ?? '') ||
      enabled !== (editingTool.enabled ?? true)
    );
  }, [editingTool, description, shortDescription, enabled]);

  const handleSubmit = async () => {
    if (!editingTool) return;

    if (!hasChanges) {
      toast.info('No changes detected. Please modify at least one field before saving.');
      return;
    }

    try {
      await updateTool.mutateAsync({
        toolId: editingTool.toolId,
        description,
        shortDescription,
        enabled,
      });
      setEditingTool(null);
    } catch (error) {
      // Error is handled by the mutation hook
    }
  };

  const handleCancel = () => {
    setEditingTool(null);
    setDescription('');
    setShortDescription('');
    setEnabled(true);
  };

  const getSuccessRate = (tool: IToolDefinition): string => {
    if (tool.usageCount === 0) return 'N/A';
    return `${((tool.successCount / tool.usageCount) * 100).toFixed(1)}%`;
  };

  const getSuccessRateColor = (tool: IToolDefinition): 'success' | 'danger' | 'neutral' => {
    if (tool.usageCount === 0) return 'neutral';
    const rate = tool.successCount / tool.usageCount;
    return rate >= 0.9 ? 'success' : 'danger';
  };

  return (
    <Sheet sx={{ p: { xs: 1, sm: 2 }, width: '100%', overflow: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: { xs: 1.5, sm: 3 } }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="h2">Tool Definitions</Typography>
          <ContextHelpButton helpId="admin/tool-definitions" tooltipText="Tool Definitions Help" />
        </Stack>
        <IconButton onClick={() => refetch()} variant="outlined" color="neutral">
          <RefreshIcon />
        </IconButton>
      </Stack>

      {/* Filters */}
      <Card variant="outlined" sx={{ mb: { xs: 1, sm: 2 }, p: { xs: 1, sm: 2 } }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 1, sm: 2 }} alignItems={{ sm: 'flex-end' }}>
          <FormControl sx={{ flex: 1, width: '100%' }}>
            <FormLabel>Search</FormLabel>
            <Input
              placeholder="Search by name, description, or tags..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              startDecorator={<SearchIcon />}
            />
          </FormControl>

          {/* Dropdowns: side-by-side on mobile, inline on desktop */}
          <Stack direction="row" spacing={{ xs: 1, sm: 2 }} sx={{ width: { xs: '100%', sm: 'auto' } }}>
            <FormControl sx={{ flex: { xs: 1, sm: 'none' }, minWidth: { sm: 180 } }}>
              <FormLabel>Category</FormLabel>
              <Select value={categoryFilter} onChange={(_, value) => setCategoryFilter(value || 'all')}>
                <Option value="all">All Categories</Option>
                {data?.categories.map((cat: string) => (
                  <Option key={cat} value={cat}>
                    {cat}
                  </Option>
                ))}
              </Select>
            </FormControl>

            <FormControl sx={{ flex: { xs: 1, sm: 'none' }, minWidth: { sm: 140 } }}>
              <FormLabel>Status</FormLabel>
              <Select value={enabledFilter} onChange={(_, value) => setEnabledFilter(value || 'all')}>
                <Option value="all">All Status</Option>
                <Option value="true">Enabled</Option>
                <Option value="false">Disabled</Option>
              </Select>
            </FormControl>
          </Stack>
        </Stack>
      </Card>

      {isLoading && <LinearProgress sx={{ mb: 2 }} />}

      {/* Results Summary */}
      {data && (
        <Typography level="body-sm" sx={{ mb: 1, color: 'text.secondary' }}>
          Showing {data.tools.length} of {data.total} tools
          {data.pagination &&
            data.pagination.totalPages > 1 &&
            ` (Page ${data.pagination.page} of ${data.pagination.totalPages})`}
        </Typography>
      )}

      {/* Top Pagination */}
      {data && data.pagination && data.pagination.totalPages > 1 && (
        <Stack direction="row" justifyContent="center" alignItems="center" spacing={2} sx={{ mb: { xs: 1, sm: 2 } }}>
          <IconButton
            variant="outlined"
            color="neutral"
            size="sm"
            disabled={!data.pagination.hasPrevPage}
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            aria-label="Previous page"
          >
            <ChevronLeftIcon />
          </IconButton>
          <Stack direction="row" spacing={1} alignItems="center">
            {Array.from({ length: Math.min(5, data.pagination.totalPages) }, (_, i) => {
              const totalPages = data.pagination.totalPages;
              let pageNum: number;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (currentPage <= 3) {
                pageNum = i + 1;
              } else if (currentPage >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = currentPage - 2 + i;
              }
              return (
                <Button
                  key={pageNum}
                  variant={pageNum === currentPage ? 'solid' : 'plain'}
                  color={pageNum === currentPage ? 'primary' : 'neutral'}
                  size="sm"
                  sx={{ minWidth: 36 }}
                  onClick={() => setCurrentPage(pageNum)}
                >
                  {pageNum}
                </Button>
              );
            })}
          </Stack>
          <IconButton
            variant="outlined"
            color="neutral"
            size="sm"
            disabled={!data.pagination.hasNextPage}
            onClick={() => setCurrentPage(p => p + 1)}
            aria-label="Next page"
          >
            <ChevronRightIcon />
          </IconButton>
        </Stack>
      )}

      {/* Tools Table / Card List */}
      {data &&
        data.tools.length > 0 &&
        (isMobile ? (
          <Stack spacing={1}>
            {data.tools.map((tool: IToolDefinition) => (
              <Card key={tool.toolId} variant="outlined" sx={{ p: 1.5 }}>
                <Stack spacing={0.75}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0, mr: 0.5 }}>
                      <Typography level="title-sm" fontWeight="lg" noWrap>
                        {tool.toolName}
                      </Typography>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap">
                        <Chip size="sm" variant="soft" color="neutral">
                          {tool.category}
                        </Chip>
                        <Chip size="sm" variant="soft" color={tool.source === 'database' ? 'primary' : 'neutral'}>
                          {tool.source === 'database' ? 'DB' : 'Code'}
                        </Chip>
                        {tool.hasOverride && (
                          <Chip size="sm" color="primary" variant="soft">
                            Override
                          </Chip>
                        )}
                        {tool.tags?.slice(0, 2).map((tag: string) => (
                          <Chip key={tag} size="sm" variant="outlined" color="neutral">
                            {tag}
                          </Chip>
                        ))}
                        {tool.tags && tool.tags.length > 2 && (
                          <Chip size="sm" variant="soft" color="neutral">
                            +{tool.tags.length - 2}
                          </Chip>
                        )}
                      </Stack>
                    </Stack>
                    {/* Actions + status on the same row */}
                    <Stack direction="row" spacing={0.25} alignItems="center" sx={{ flexShrink: 0 }}>
                      <Tooltip title="View Details">
                        <IconButton size="sm" variant="plain" color="neutral" onClick={() => setViewingTool(tool)}>
                          <VisibilityIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit">
                        <IconButton size="sm" variant="plain" color="primary" onClick={() => setEditingTool(tool)}>
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      {tool.hasOverride && (
                        <Tooltip title="Revert to Code Defaults">
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="warning"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Revert "${tool.toolName}" to code defaults? This will delete the database override.`
                                )
                              ) {
                                deleteTool.mutate(tool.toolId);
                              }
                            }}
                            disabled={deleteTool.isPending}
                          >
                            <RestoreIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                      {tool.enabled ? (
                        <CheckCircleIcon color="success" fontSize="small" />
                      ) : (
                        <CancelIcon color="error" fontSize="small" />
                      )}
                    </Stack>
                  </Stack>
                  {tool.shortDescription && (
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      {tool.shortDescription}
                    </Typography>
                  )}
                  <Stack direction="row" spacing={2} flexWrap="wrap">
                    <Typography level="body-xs">{tool.version > 0 ? `v${tool.version}` : '-'}</Typography>
                    <Typography level="body-xs">Usage: {tool.usageCount}</Typography>
                    <Typography level="body-xs" color={getSuccessRateColor(tool)}>
                      Success: {getSuccessRate(tool)}
                    </Typography>
                  </Stack>
                </Stack>
              </Card>
            ))}
          </Stack>
        ) : (
          <Box sx={{ overflow: 'auto', maxHeight: 'calc(100vh - 350px)' }}>
            <Table stickyHeader hoverRow>
              <thead>
                <tr>
                  <th style={{ width: '20%' }}>Tool Name</th>
                  <th style={{ width: '25%' }}>Short Description</th>
                  <th style={{ width: '12%' }}>Category</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>Source</th>
                  <th style={{ width: '6%', textAlign: 'center' }}>Version</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>Usage</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>Success</th>
                  <th style={{ width: '6%', textAlign: 'center' }}>Status</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.tools.map((tool: IToolDefinition) => (
                  <tr key={tool.toolId}>
                    <td>
                      <Stack spacing={0.5}>
                        <Typography level="body-sm" fontWeight="lg">
                          {tool.toolName}
                        </Typography>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap">
                          {tool.hasOverride && (
                            <Chip size="sm" color="primary" variant="soft">
                              Override
                            </Chip>
                          )}
                          {tool.tags?.slice(0, 2).map((tag: string) => (
                            <Chip key={tag} size="sm" variant="outlined" color="neutral">
                              {tag}
                            </Chip>
                          ))}
                          {tool.tags && tool.tags.length > 2 && (
                            <Chip size="sm" variant="soft" color="neutral">
                              +{tool.tags.length - 2}
                            </Chip>
                          )}
                        </Stack>
                      </Stack>
                    </td>
                    <td>
                      <Tooltip title={tool.shortDescription} arrow placement="top">
                        <Typography
                          level="body-sm"
                          sx={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {tool.shortDescription}
                        </Typography>
                      </Tooltip>
                    </td>
                    <td>
                      <Chip size="sm" variant="soft" color="neutral">
                        {tool.category}
                      </Chip>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Chip size="sm" variant="soft" color={tool.source === 'database' ? 'primary' : 'neutral'}>
                        {tool.source === 'database' ? 'DB' : 'Code'}
                      </Chip>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Typography level="body-sm">{tool.version > 0 ? `v${tool.version}` : '-'}</Typography>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Typography level="body-sm">{tool.usageCount}</Typography>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Typography level="body-sm" color={getSuccessRateColor(tool)}>
                        {getSuccessRate(tool)}
                      </Typography>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {tool.enabled ? (
                        <CheckCircleIcon color="success" fontSize="small" />
                      ) : (
                        <CancelIcon color="error" fontSize="small" />
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Stack direction="row" spacing={0.5} justifyContent="center">
                        <Tooltip title="View Details">
                          <IconButton size="sm" variant="plain" color="neutral" onClick={() => setViewingTool(tool)}>
                            <VisibilityIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Edit">
                          <IconButton size="sm" variant="plain" color="primary" onClick={() => setEditingTool(tool)}>
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                        {tool.hasOverride && (
                          <Tooltip title="Revert to Code Defaults">
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="warning"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Revert "${tool.toolName}" to code defaults? This will delete the database override.`
                                  )
                                ) {
                                  deleteTool.mutate(tool.toolId);
                                }
                              }}
                              disabled={deleteTool.isPending}
                            >
                              <RestoreIcon />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Box>
        ))}

      {/* Pagination Controls */}
      {data && data.pagination && data.pagination.totalPages > 1 && (
        <Stack direction="row" justifyContent="center" alignItems="center" spacing={2} sx={{ mt: 2 }}>
          <IconButton
            variant="outlined"
            color="neutral"
            size="sm"
            disabled={!data.pagination.hasPrevPage}
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            aria-label="Previous page"
          >
            <ChevronLeftIcon />
          </IconButton>
          <Stack direction="row" spacing={1} alignItems="center">
            {/* Show page numbers */}
            {Array.from({ length: Math.min(5, data.pagination.totalPages) }, (_, i) => {
              const totalPages = data.pagination.totalPages;
              let pageNum: number;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (currentPage <= 3) {
                pageNum = i + 1;
              } else if (currentPage >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = currentPage - 2 + i;
              }
              return (
                <Button
                  key={pageNum}
                  variant={pageNum === currentPage ? 'solid' : 'plain'}
                  color={pageNum === currentPage ? 'primary' : 'neutral'}
                  size="sm"
                  sx={{ minWidth: 36 }}
                  onClick={() => setCurrentPage(pageNum)}
                >
                  {pageNum}
                </Button>
              );
            })}
          </Stack>
          <IconButton
            variant="outlined"
            color="neutral"
            size="sm"
            disabled={!data.pagination.hasNextPage}
            onClick={() => setCurrentPage(p => p + 1)}
            aria-label="Next page"
          >
            <ChevronRightIcon />
          </IconButton>
        </Stack>
      )}

      {/* Empty State */}
      {data && data.tools.length === 0 && !isLoading && (
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
          <Typography level="h3" sx={{ mb: 1 }}>
            No Tools Found
          </Typography>
          <Typography level="body-md" sx={{ color: 'text.secondary' }}>
            {debouncedSearch || categoryFilter !== 'all' || enabledFilter !== 'all'
              ? 'Try adjusting your filters'
              : 'No tools are currently loaded'}
          </Typography>
        </Box>
      )}

      {/* View Modal */}
      <Modal open={!!viewingTool} onClose={() => setViewingTool(null)}>
        <ModalDialog sx={{ width: 700, maxHeight: '90vh', overflow: 'auto' }}>
          <Typography level="h4">{viewingTool?.toolName}</Typography>
          <Stack spacing={2} sx={{ mt: 2 }}>
            <Box>
              <Typography level="body-sm" fontWeight="lg">
                Tool ID
              </Typography>
              <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
                {viewingTool?.toolId}
              </Typography>
            </Box>
            <Box>
              <Typography level="body-sm" fontWeight="lg">
                Category
              </Typography>
              <Typography level="body-sm">{viewingTool?.category}</Typography>
            </Box>
            <Box>
              <Typography level="body-sm" fontWeight="lg">
                Tags
              </Typography>
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {viewingTool?.tags?.map(tag => (
                  <Chip key={tag} size="sm" variant="soft">
                    {tag}
                  </Chip>
                )) || <Typography level="body-sm">No tags</Typography>}
              </Stack>
            </Box>
            <Box>
              <Typography level="body-sm" fontWeight="lg">
                Short Description
              </Typography>
              <Typography level="body-sm">{viewingTool?.shortDescription}</Typography>
            </Box>
            <Box>
              <Typography level="body-sm" fontWeight="lg">
                Full Description
              </Typography>
              <Sheet variant="soft" sx={{ p: 2, maxHeight: 200, overflow: 'auto', borderRadius: 'sm' }}>
                <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
                  {viewingTool?.description}
                </Typography>
              </Sheet>
            </Box>
            <Stack direction="row" spacing={4}>
              <Box>
                <Typography level="body-sm" fontWeight="lg">
                  Source
                </Typography>
                <Chip size="sm" color={viewingTool?.source === 'database' ? 'primary' : 'neutral'}>
                  {viewingTool?.source === 'database' ? 'Database Override' : 'Code'}
                </Chip>
              </Box>
              <Box>
                <Typography level="body-sm" fontWeight="lg">
                  Version
                </Typography>
                <Typography level="body-sm">{viewingTool?.version ? `v${viewingTool.version}` : 'N/A'}</Typography>
              </Box>
              <Box>
                <Typography level="body-sm" fontWeight="lg">
                  Status
                </Typography>
                <Chip size="sm" color={viewingTool?.enabled ? 'success' : 'danger'}>
                  {viewingTool?.enabled ? 'Enabled' : 'Disabled'}
                </Chip>
              </Box>
            </Stack>
            <Stack direction="row" spacing={4}>
              <Box>
                <Typography level="body-sm" fontWeight="lg">
                  Usage Count
                </Typography>
                <Typography level="body-sm">{viewingTool?.usageCount ?? 0}</Typography>
              </Box>
              <Box>
                <Typography level="body-sm" fontWeight="lg">
                  Success Rate
                </Typography>
                <Typography level="body-sm" color={viewingTool ? getSuccessRateColor(viewingTool) : 'neutral'}>
                  {viewingTool ? getSuccessRate(viewingTool) : 'N/A'}
                </Typography>
              </Box>
            </Stack>
            {viewingTool?.lastUpdatedByName && (
              <Box>
                <Typography level="body-sm" fontWeight="lg">
                  Last Updated By
                </Typography>
                <Typography level="body-sm">
                  {viewingTool.lastUpdatedByName}
                  {viewingTool.updatedAt && ` at ${new Date(viewingTool.updatedAt).toLocaleString()}`}
                </Typography>
              </Box>
            )}
            <Stack direction="row" justifyContent="flex-end" sx={{ mt: 2 }}>
              <Button variant="outlined" onClick={() => setViewingTool(null)}>
                Close
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Edit Modal */}
      <Modal open={!!editingTool} onClose={handleCancel}>
        <ModalDialog sx={{ width: 800, maxHeight: '90vh', overflow: 'auto' }}>
          <Typography level="h4">Edit Tool: {editingTool?.toolName}</Typography>
          <Stack spacing={2} sx={{ mt: 2 }}>
            <FormControl>
              <FormLabel>Short Description (UI Display)</FormLabel>
              <Input
                value={shortDescription}
                onChange={e => setShortDescription(e.target.value)}
                placeholder="Brief description for UI display"
              />
              <FormHelperText>10-500 characters ({shortDescription.length}/500)</FormHelperText>
            </FormControl>

            <FormControl>
              <FormLabel>Full Description (5-Section Template)</FormLabel>
              <Textarea
                minRows={10}
                maxRows={20}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={`**DATA TYPE:** [UTILITY | SEARCH | GENERATION | etc.]

**WHEN TO USE:**
• Use case 1
• Use case 2

**WHEN NOT TO USE:**
• Scenario → use [other_tool] instead

**RETURNS:**
• Output field 1: Description

**EXAMPLE QUESTIONS:**
• "Example question this tool answers"`}
              />
              <FormHelperText>50-10,000 characters ({description.length}/10,000)</FormHelperText>
            </FormControl>

            <FormControl orientation="horizontal" sx={{ gap: 2 }}>
              <Switch checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              <FormLabel>{enabled ? 'Enabled' : 'Disabled'}</FormLabel>
            </FormControl>

            <Alert color="warning" variant="soft">
              {editingTool?.hasOverride
                ? `Saving will create version ${(editingTool.version || 0) + 1}`
                : 'This will create the first override (v1) for this code-only tool'}
            </Alert>

            {!hasChanges && (
              <Alert variant="soft" color="neutral">
                No changes detected. Modify at least one field to enable saving.
              </Alert>
            )}

            <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 2 }}>
              <Button variant="outlined" onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                loading={updateTool.isPending}
                disabled={!hasChanges}
                aria-label={!hasChanges ? 'Save disabled - no changes' : undefined}
              >
                {editingTool?.hasOverride
                  ? `Save Changes (Create v${(editingTool.version || 0) + 1})`
                  : 'Create Override (v1)'}
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>
    </Sheet>
  );
};

export default ToolDefinitionsTab;
