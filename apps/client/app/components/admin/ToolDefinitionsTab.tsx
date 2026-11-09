import React, { useState, useMemo, useEffect } from 'react';
import {
  Alert,
  Button,
  DialogContent,
  Dropdown,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  ListDivider,
  Menu,
  MenuButton,
  MenuItem,
  Sheet,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import RefreshIcon from '@mui/icons-material/Refresh';
import { toast } from 'sonner';
import {
  useToolDefinitions,
  useUpdateToolDefinition,
  useDeleteToolDefinition,
  type IToolDefinition,
  type ToolDefinitionsFilters,
} from '@client/app/hooks/data/toolDefinitions';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import {
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  FilterBar,
  StatusChip,
  UpdatingBar,
  type AdminListState,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';
import { Dash, DialogFooter, Field, TruncatedText } from './promptAndToolParts';

const PAGE_SIZE = 50;

// FilterBar keys; an empty value means the filter is off ('all').
const CATEGORY_FILTER = 'tool-category';
const STATUS_FILTER = 'tool-status';

const toEnabledFilter = (value: string | undefined): 'true' | 'false' | 'all' =>
  value === 'true' || value === 'false' ? value : 'all';

const enabledChip = (tool: IToolDefinition, testId?: string) => (
  <StatusChip
    tone={tool.enabled ? 'good' : 'neutral'}
    label={tool.enabled ? 'Enabled' : 'Disabled'}
    data-testid={testId}
  />
);

function ToolRowMenu({
  tool,
  onView,
  onEdit,
  onRevert,
}: {
  tool: IToolDefinition;
  onView: (tool: IToolDefinition) => void;
  onEdit: (tool: IToolDefinition) => void;
  onRevert: (tool: IToolDefinition) => void;
}) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            'aria-label': `Actions for ${tool.toolName}`,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        data-testid={`tool-row-actions-${tool.toolId}`}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
        <MenuItem onClick={() => onView(tool)} data-testid={`tool-row-view-${tool.toolId}`}>
          View details
        </MenuItem>
        <MenuItem onClick={() => onEdit(tool)} data-testid={`tool-row-edit-${tool.toolId}`}>
          Edit tool
        </MenuItem>
        {tool.hasOverride && (
          <>
            <ListDivider />
            <MenuItem onClick={() => onRevert(tool)} data-testid={`tool-row-revert-${tool.toolId}`}>
              Revert to code defaults
            </MenuItem>
          </>
        )}
      </Menu>
    </Dropdown>
  );
}

const ToolDefinitionsTab: React.FC = () => {
  // Filter state
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [enabledFilter, setEnabledFilter] = useState<'true' | 'false' | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  // Modal state
  const [viewingTool, setViewingTool] = useState<IToolDefinition | null>(null);
  const [editingTool, setEditingTool] = useState<IToolDefinition | null>(null);
  const [revertingTool, setRevertingTool] = useState<IToolDefinition | null>(null);

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
      limit: pageSize,
    }),
    [categoryFilter, enabledFilter, debouncedSearch, currentPage, pageSize]
  );

  const { data, isLoading, isFetching, error, refetch } = useToolDefinitions(filters);
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

  const handleRevert = () => {
    if (!revertingTool) return;
    // The mutation hook reports the outcome; the dialog stays open on a failure so it can be retried.
    deleteTool.mutate(revertingTool.toolId, { onSuccess: () => setRevertingTool(null) });
  };

  const getSuccessRate = (tool: IToolDefinition): string => {
    if (tool.usageCount === 0) return 'N/A';
    return `${((tool.successCount / tool.usageCount) * 100).toFixed(1)}%`;
  };

  const hasFilters =
    debouncedSearch !== '' || searchQuery !== '' || categoryFilter !== 'all' || enabledFilter !== 'all';

  const clearFilters = () => {
    setSearchQuery('');
    // Skips the debounce so the cleared list loads in one request.
    setDebouncedSearch('');
    setCategoryFilter('all');
    setEnabledFilter('all');
  };

  const filterState: AdminListState = {
    query: searchQuery,
    view: '',
    filters: {
      [CATEGORY_FILTER]: categoryFilter === 'all' ? '' : categoryFilter,
      [STATUS_FILTER]: enabledFilter === 'all' ? '' : enabledFilter,
    },
  };

  const handleFilterChange = (patch: Partial<AdminListState>) => {
    if (patch.query !== undefined) setSearchQuery(patch.query);
    if (patch.filters) {
      setCategoryFilter(patch.filters[CATEGORY_FILTER] || 'all');
      setEnabledFilter(toEnabledFilter(patch.filters[STATUS_FILTER]));
    }
  };

  const columns: DataColumn<IToolDefinition>[] = [
    {
      id: 'name',
      label: 'Tool',
      width: '16rem',
      render: tool => (
        <Stack gap={0.5} sx={{ minWidth: 0 }}>
          <TruncatedText text={tool.toolName} testId={`tool-name-${tool.toolId}`} />
          {tool.tags && tool.tags.length > 0 && (
            <Stack direction="row" flexWrap="wrap" gap={0.5}>
              {tool.tags.slice(0, 2).map((tag: string) => (
                <StatusChip key={tag} tone="neutral" label={tag} />
              ))}
              {tool.tags.length > 2 && <StatusChip tone="neutral" label={`+${tool.tags.length - 2}`} />}
            </Stack>
          )}
        </Stack>
      ),
    },
    {
      id: 'description',
      label: 'Short description',
      render: tool => (tool.shortDescription ? <TruncatedText text={tool.shortDescription} /> : <Dash />),
    },
    {
      id: 'category',
      label: 'Category',
      width: '9.5rem',
      render: tool => <StatusChip tone="neutral" label={tool.category} />,
    },
    {
      id: 'source',
      label: 'Source',
      width: '5.5rem',
      render: tool => (
        <StatusChip
          tone="neutral"
          label={tool.source === 'database' ? 'DB' : 'Code'}
          data-testid={`tool-source-${tool.toolId}`}
        />
      ),
    },
    {
      id: 'version',
      label: 'Version',
      width: '5rem',
      render: tool => (tool.version > 0 ? `v${tool.version}` : <Dash />),
    },
    {
      id: 'usage',
      label: 'Usage',
      width: '5rem',
      numeric: true,
      render: tool => tool.usageCount.toLocaleString(),
    },
    {
      id: 'success',
      label: 'Success',
      width: '5rem',
      numeric: true,
      render: tool => getSuccessRate(tool),
    },
    {
      id: 'status',
      label: 'Status',
      width: '6rem',
      render: tool => enabledChip(tool, `tool-status-${tool.toolId}`),
    },
  ];

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-tool-definitions-tab">
      <AdminPageHeader
        title="Tools"
        count={data?.total}
        description="The tools AI agents can call, with their descriptions, overrides and usage."
        actions={
          <>
            <ContextHelpButton helpId="admin/tool-definitions" tooltipText="Tools help" />
            <Button
              variant="outlined"
              size="sm"
              startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
              loading={isFetching}
              onClick={() => void refetch()}
              data-testid="tools-refresh-btn"
              sx={adminFocus}
            >
              Refresh
            </Button>
          </>
        }
      />

      <FilterBar
        state={filterState}
        searchLabel="Search name, description or tags"
        filters={[
          {
            id: CATEGORY_FILTER,
            label: 'Category',
            options: (data?.categories ?? []).map((cat: string) => ({ value: cat, label: cat })),
          },
          {
            id: STATUS_FILTER,
            label: 'Status',
            options: [
              { value: 'true', label: 'Enabled' },
              { value: 'false', label: 'Disabled' },
            ],
          },
        ]}
        onChange={handleFilterChange}
      />

      <Stack gap={1} sx={{ minWidth: 0 }}>
        <UpdatingBar active={isFetching && !isLoading} testId="tools-updating-bar" />
        <DataTable
          label="Tools"
          testId="tools-table"
          rows={data?.tools ?? []}
          columns={columns}
          getRowId={tool => tool.toolId}
          rowTestId={tool => `tool-row-${tool.toolId}`}
          loading={isLoading}
          error={error ? 'Could not load the tools.' : undefined}
          onRetry={() => void refetch()}
          empty={
            hasFilters ? (
              <EmptyState
                title="No tools match these filters"
                action={
                  <Button variant="outlined" onClick={clearFilters} data-testid="tools-empty-clear-btn">
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No tools are loaded"
                action={
                  <Button variant="outlined" onClick={() => void refetch()} data-testid="tools-empty-refresh-btn">
                    Refresh
                  </Button>
                }
              />
            )
          }
          pagination={{
            page: currentPage,
            pageSize,
            total: data?.total ?? 0,
            onPageChange: setCurrentPage,
            onPageSizeChange: size => {
              setPageSize(size);
              setCurrentPage(1);
            },
          }}
          rowActions={tool => (
            <ToolRowMenu tool={tool} onView={setViewingTool} onEdit={setEditingTool} onRevert={setRevertingTool} />
          )}
          // Wide enough that every column keeps one line; below it the table scrolls inside its frame.
          minWidth="68rem"
          maxHeight="none"
        />
      </Stack>

      {/* View dialog */}
      <AdminDialog
        open={viewingTool !== null}
        onClose={() => setViewingTool(null)}
        title={viewingTool?.toolName ?? 'Tool details'}
        width={700}
        data-testid="tool-view-dialog"
      >
        {viewingTool && (
          <DialogContent sx={{ gap: 2 }}>
            <Field label="Tool ID">
              <Typography level="body-sm" sx={{ fontFamily: 'code' }} data-testid="tool-view-id">
                {viewingTool.toolId}
              </Typography>
            </Field>
            <Field label="Category">
              <Typography level="body-sm">{viewingTool.category}</Typography>
            </Field>
            <Field label="Tags">
              <Stack direction="row" gap={0.5} flexWrap="wrap">
                {viewingTool.tags?.length ? (
                  viewingTool.tags.map(tag => <StatusChip key={tag} tone="neutral" label={tag} />)
                ) : (
                  <Typography level="body-sm" data-testid="tool-view-no-tags">
                    No tags
                  </Typography>
                )}
              </Stack>
            </Field>
            <Field label="Short description">
              <Typography level="body-sm">{viewingTool.shortDescription}</Typography>
            </Field>
            <Field label="Full description">
              <Sheet
                variant="outlined"
                sx={{ p: 2, maxHeight: 200, overflow: 'auto', borderRadius: 'sm', borderColor: 'admin.border' }}
              >
                <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
                  {viewingTool.description}
                </Typography>
              </Sheet>
            </Field>
            <Stack direction="row" gap={4} flexWrap="wrap">
              <Field label="Source">
                <StatusChip tone="neutral" label={viewingTool.source === 'database' ? 'Database override' : 'Code'} />
              </Field>
              <Field label="Version">
                <Typography level="body-sm">{viewingTool.version ? `v${viewingTool.version}` : 'N/A'}</Typography>
              </Field>
              <Field label="Status">{enabledChip(viewingTool, 'tool-view-status')}</Field>
            </Stack>
            <Stack direction="row" gap={4} flexWrap="wrap">
              <Field label="Usage count">
                <Typography level="body-sm">{(viewingTool.usageCount ?? 0).toLocaleString()}</Typography>
              </Field>
              <Field label="Success rate">
                <Typography level="body-sm">{getSuccessRate(viewingTool)}</Typography>
              </Field>
            </Stack>
            {viewingTool.lastUpdatedByName && (
              <Field label="Last updated by">
                <Typography level="body-sm">
                  {viewingTool.lastUpdatedByName}
                  {viewingTool.updatedAt && ` at ${new Date(viewingTool.updatedAt).toLocaleString()}`}
                </Typography>
              </Field>
            )}
          </DialogContent>
        )}
        <DialogFooter>
          <Button variant="outlined" onClick={() => setViewingTool(null)} data-testid="tool-view-close-btn">
            Close
          </Button>
        </DialogFooter>
      </AdminDialog>

      {/* Edit dialog */}
      <AdminDialog
        open={editingTool !== null}
        onClose={handleCancel}
        title="Edit tool"
        width={800}
        data-testid="tool-edit-dialog"
      >
        <DialogContent sx={{ gap: 2 }}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="tool-edit-name">
            {editingTool?.toolName}
          </Typography>

          <FormControl>
            <FormLabel>Short description (UI display)</FormLabel>
            <Input
              value={shortDescription}
              onChange={e => setShortDescription(e.target.value)}
              placeholder="Brief description for UI display"
              slotProps={{ input: { 'data-testid': 'tool-edit-short-description-input' } }}
            />
            <FormHelperText>10-500 characters ({shortDescription.length}/500)</FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel>Full description (5-section template)</FormLabel>
            <Textarea
              minRows={10}
              maxRows={20}
              value={description}
              onChange={e => setDescription(e.target.value)}
              slotProps={{ textarea: { 'data-testid': 'tool-edit-description-input' } }}
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
            <Switch
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              slotProps={{ input: { 'data-testid': 'tool-edit-enabled-switch' } }}
            />
            <FormLabel>{enabled ? 'Enabled' : 'Disabled'}</FormLabel>
          </FormControl>

          <Alert color="neutral" variant="soft" data-testid="tool-edit-version-note">
            {editingTool?.hasOverride
              ? `Saving will create version ${(editingTool.version || 0) + 1}`
              : 'This will create the first override (v1) for this code-only tool'}
          </Alert>

          {!hasChanges && (
            <Alert variant="soft" color="neutral">
              No changes detected. Modify at least one field to enable saving.
            </Alert>
          )}
        </DialogContent>

        <DialogFooter>
          <Button variant="outlined" onClick={handleCancel} data-testid="tool-edit-cancel-btn">
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={updateTool.isPending}
            disabled={!hasChanges}
            aria-label={!hasChanges ? 'Save disabled - no changes' : undefined}
            data-testid="tool-edit-save-btn"
          >
            {editingTool?.hasOverride
              ? `Save changes (create v${(editingTool.version || 0) + 1})`
              : 'Create override (v1)'}
          </Button>
        </DialogFooter>
      </AdminDialog>

      {/* Revert confirm */}
      <AdminDialog
        open={revertingTool !== null}
        // Esc, the X and the backdrop wait for an in-flight revert, like the disabled Cancel.
        onClose={() => {
          if (!deleteTool.isPending) setRevertingTool(null);
        }}
        title="Revert to code defaults"
        role="alertdialog"
        data-testid="tool-revert-dialog"
      >
        <DialogContent>
          <Typography level="body-sm" component="div">
            Deletes the database override for <strong>{revertingTool?.toolName}</strong>, so the tool goes back to its
            code defaults. This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => setRevertingTool(null)}
            disabled={deleteTool.isPending}
            data-testid="tool-revert-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            color="danger"
            loading={deleteTool.isPending}
            onClick={handleRevert}
            data-testid="tool-revert-confirm-btn"
          >
            Revert to code defaults
          </Button>
        </DialogFooter>
      </AdminDialog>
    </Stack>
  );
};

export default ToolDefinitionsTab;
