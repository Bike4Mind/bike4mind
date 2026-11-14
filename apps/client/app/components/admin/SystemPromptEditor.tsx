import React, { useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  DialogContent,
  Divider,
  FormControl,
  FormLabel,
  Input,
  ListDivider,
  MenuItem,
  Option,
  Select,
  Sheet,
  Stack,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import HistoryIcon from '@mui/icons-material/History';
import SaveIcon from '@mui/icons-material/Save';
import {
  useSystemPrompts,
  useUpdateSystemPrompt,
  useCreateSystemPrompt,
  useDeleteSystemPrompt,
} from '@client/app/hooks/data/systemPrompts';
import { IAdminSystemPrompt, IAdminSystemPromptHistory } from '@bike4mind/common';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import {
  AdminDialog,
  DataTable,
  EmptyState,
  FilterBar,
  StatusChip,
  UpdatingBar,
  type AdminFilter,
  type AdminListState,
  type DataColumn,
} from './shared';
import { Dash, DialogFooter, Field, TruncatedText } from './promptAndToolParts';
import { RowActionsMenu } from './shared/RowActionsMenu';

/** Extended type for prompts returned by the API (includes computed fields) */
interface ISystemPromptWithMeta extends Omit<IAdminSystemPrompt, 'activeVersion'> {
  /** Whether this prompt has a DB override */
  hasOverride: boolean;
  /** Source of this prompt data ('code' or 'db') */
  source: 'code' | 'db';
  /** Timestamp fields from MongoDB */
  createdAt: Date;
  updatedAt: Date;
  /** Active version - 0 = code default, 1+ = stored version, undefined for legacy */
  activeVersion?: number;
  /** True when an active DB override's content has drifted from the current code default */
  divergesFromCodeDefault?: boolean;
  /** False for DB-only prompts: there is no code default behind them, so they can be deleted outright */
  hasCodeDefault?: boolean;
}

/** Get the effective active version (handles legacy prompts without activeVersion)
 * Returns: 0 = code default, 1+ = stored version
 */
const getActiveVersion = (prompt: ISystemPromptWithMeta): number => {
  // Handle legacy prompts or invalid values
  if (prompt.activeVersion === undefined || prompt.activeVersion === null) {
    return prompt.version;
  }
  const numVersion = Number(prompt.activeVersion);
  return isNaN(numVersion) ? prompt.version : numVersion;
};

/** Format version for display (0 = Default, 1+ = vN) */
const formatVersion = (version: number): string => {
  if (version === 0) return 'Default';
  return `v${version}`;
};

/** What the page header needs from the editor; SystemPromptsTab renders the header itself. */
export type SystemPromptsHeaderState = {
  count: number | undefined;
  refreshing: boolean;
  onRefresh: () => void;
  onCreate: () => void;
};

type SystemPromptEditorProps = {
  renderHeader: (header: SystemPromptsHeaderState) => ReactNode;
};

type SourceFilter = 'all' | 'code' | 'db';
type EnabledFilter = 'all' | 'true' | 'false';

// FilterBar keys; an empty value means the filter is off ('all').
const CATEGORY_FILTER = 'prompt-category';
const SOURCE_FILTER = 'prompt-source';
const STATUS_FILTER = 'prompt-status';

const toSourceFilter = (value: string | undefined): SourceFilter =>
  value === 'code' || value === 'db' ? value : 'all';
const toEnabledFilter = (value: string | undefined): EnabledFilter =>
  value === 'true' || value === 'false' ? value : 'all';

const HIDDEN_TAGS = ['system-message', 'user-message', 'main-prompt', 'behavior-config'];

function PromptRowMenu({
  prompt,
  onView,
  onEdit,
  onDelete,
}: {
  prompt: ISystemPromptWithMeta;
  onView: (prompt: ISystemPromptWithMeta) => void;
  onEdit: (prompt: ISystemPromptWithMeta) => void;
  onDelete: (prompt: ISystemPromptWithMeta) => void;
}) {
  return (
    <RowActionsMenu testId={`system-prompt-row-actions-${prompt.promptId}`} ariaLabel={`Actions for ${prompt.name}`}>
      <MenuItem onClick={() => onView(prompt)} data-testid={`system-prompt-row-view-${prompt.promptId}`}>
        View details
      </MenuItem>
      <MenuItem onClick={() => onEdit(prompt)} data-testid={`system-prompt-row-edit-${prompt.promptId}`}>
        {prompt.hasOverride ? 'Edit override' : 'Create override'}
      </MenuItem>
      {/* Only DB-only prompts can be deleted; ones with a code default are reset instead */}
      {prompt.hasCodeDefault === false && (
        <>
          <ListDivider />
          <MenuItem onClick={() => onDelete(prompt)} data-testid={`system-prompt-delete-btn-${prompt.promptId}`}>
            Delete prompt
          </MenuItem>
        </>
      )}
    </RowActionsMenu>
  );
}

const SystemPromptEditor: React.FC<SystemPromptEditorProps> = ({ renderHeader }) => {
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'true' | 'false'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'code' | 'db'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingPrompt, setEditingPrompt] = useState<ISystemPromptWithMeta | null>(null);
  const [viewingPrompt, setViewingPrompt] = useState<ISystemPromptWithMeta | null>(null);
  const [deletingPrompt, setDeletingPrompt] = useState<ISystemPromptWithMeta | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Version history state
  const [versionHistory, setVersionHistory] = useState<IAdminSystemPromptHistory[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string>('current'); // 'current', '0' (code default), or version number string
  const [defaultPromptData, setDefaultPromptData] = useState<IAdminSystemPrompt | null>(null);
  // Track original content of selected version to detect actual edits
  const [originalContent, setOriginalContent] = useState<string>('');

  // Data hooks
  const { data, isLoading, isFetching, error, refetch } = useSystemPrompts({
    category: categoryFilter === 'all' ? undefined : categoryFilter,
    enabled: enabledFilter,
    search: searchQuery || undefined,
    source: sourceFilter === 'all' ? undefined : sourceFilter,
  });

  // Mutation hooks
  const updatePrompt = useUpdateSystemPrompt();
  const createPrompt = useCreateSystemPrompt();
  const deletePrompt = useDeleteSystemPrompt();

  const prompts = (data?.data || []) as ISystemPromptWithMeta[];
  const total = data?.count || 0;

  const categories = Array.from(new Set(prompts.map(p => p.category)));

  // Form state for editing/creating
  const [promptId, setPromptId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [enabled, setEnabled] = useState(true);

  // Raw input strings for tags/variables (allows typing commas, parsed on blur/save)
  const [tagsInput, setTagsInput] = useState('');
  const [variablesInput, setVariablesInput] = useState('');

  // Track original values for all fields to detect any changes
  const [originalFields, setOriginalFields] = useState<{
    name: string;
    description: string;
    category: string;
    tags: string[];
    variables: string[];
    enabled: boolean;
  } | null>(null);

  // Check if any field was edited (content or metadata)
  // For tags/variables, compare the input strings to the formatted original values
  const hasActualEdits =
    content !== originalContent ||
    (originalFields &&
      (name !== originalFields.name ||
        description !== originalFields.description ||
        category !== originalFields.category ||
        tagsInput !== originalFields.tags.join(', ') ||
        variablesInput !== originalFields.variables.join(', ') ||
        enabled !== originalFields.enabled));

  // Get the version number for the current selection ('0' = code default)
  const getSelectedVersionNum = useCallback((): number => {
    if (selectedVersion === '0') return 0;
    if (selectedVersion === 'current') return editingPrompt?.version ?? 0;
    return parseInt(selectedVersion, 10) || 0;
  }, [selectedVersion, editingPrompt?.version]);

  // Check if viewing the currently active version
  const isViewingActiveVersion = editingPrompt
    ? (() => {
        const activeVer = getActiveVersion(editingPrompt);
        if (activeVer === 0) {
          return selectedVersion === '0';
        }
        // activeVer is a stored version number
        return getSelectedVersionNum() === activeVer;
      })()
    : false;

  // When defaultPromptData loads and we're viewing code default, update content
  useEffect(() => {
    if (selectedVersion === '0' && defaultPromptData && editingPrompt) {
      // Don't include content/hasActualEdits in deps - would cause infinite loop
      setContent(defaultPromptData.content);
      setOriginalContent(defaultPromptData.content);
      setName(defaultPromptData.name);
      setDescription(defaultPromptData.description);
      setCategory(defaultPromptData.category);
      setTagsInput(defaultPromptData.tags.join(', '));
      setVariablesInput(defaultPromptData.variables.join(', '));
      setOriginalFields({
        name: defaultPromptData.name,
        description: defaultPromptData.description,
        category: defaultPromptData.category,
        tags: [...defaultPromptData.tags],
        variables: [...defaultPromptData.variables],
        enabled: editingPrompt.enabled, // Keep current enabled state for code defaults
      });
    }
  }, [defaultPromptData, selectedVersion, editingPrompt]);

  // When versionHistory loads and we're viewing a historical version, update content
  useEffect(() => {
    if (editingPrompt && selectedVersion !== '0' && selectedVersion !== 'current' && versionHistory.length > 0) {
      const versionNum = parseInt(selectedVersion, 10);
      const historyEntry = versionHistory.find(h => h.version === versionNum);
      if (historyEntry) {
        // Don't include content/hasActualEdits in deps - would cause infinite loop
        setContent(historyEntry.content);
        setOriginalContent(historyEntry.content);
        setName(historyEntry.name);
        setDescription(historyEntry.description);
        setCategory(historyEntry.category);
        setTagsInput(historyEntry.tags.join(', '));
        setVariablesInput(historyEntry.variables.join(', '));
        setOriginalFields({
          name: historyEntry.name,
          description: historyEntry.description,
          category: historyEntry.category,
          tags: [...historyEntry.tags],
          variables: [...historyEntry.variables],
          enabled: editingPrompt.enabled, // Keep current enabled state
        });
      }
    }
  }, [versionHistory, selectedVersion, editingPrompt]);

  const handleCreateNew = () => {
    setIsCreating(true);
    setPromptId('');
    setName('');
    setDescription('');
    setContent('');
    setCategory('system');
    setTagsInput('system');
    setVariablesInput('');
    setEnabled(true);
  };

  const handleEdit = (prompt: ISystemPromptWithMeta) => {
    setEditingPrompt(prompt);
    setPromptId(prompt.promptId);
    setName(prompt.name);
    setDescription(prompt.description);
    setContent(prompt.content);
    setCategory(prompt.category);
    setTagsInput(prompt.tags.join(', '));
    setVariablesInput(prompt.variables.join(', '));
    setEnabled(prompt.enabled);
    setOriginalContent(prompt.content);
    setOriginalFields({
      name: prompt.name,
      description: prompt.description,
      category: prompt.category,
      tags: [...prompt.tags],
      variables: [...prompt.variables],
      enabled: prompt.enabled,
    });
    setDefaultPromptData(null);

    // Set selectedVersion based on activeVersion (show what app is using)
    const activeVer = getActiveVersion(prompt);
    if (activeVer === 0) {
      setSelectedVersion('0'); // Code default
    } else if (activeVer === prompt.version) {
      setSelectedVersion('current');
    } else {
      // Active version is a historical version
      setSelectedVersion(String(activeVer));
    }

    // Load version history if it's a DB override
    if (prompt.hasOverride) {
      loadVersionHistory(prompt.promptId);
    } else {
      setVersionHistory([]);
    }
  };

  const handleView = (prompt: ISystemPromptWithMeta) => {
    setViewingPrompt(prompt);
  };

  const handleConfirmDelete = async () => {
    if (!deletingPrompt) return;
    try {
      await deletePrompt.mutateAsync(deletingPrompt.promptId);
      toast.success(`System prompt "${deletingPrompt.name}" deleted`);
      setDeletingPrompt(null);
    } catch (err: unknown) {
      console.error('Error deleting system prompt:', err);
      const errorObj = err as { response?: { data?: { error?: string; message?: string } } };
      // Prefer `message`: the delete endpoint puts its actionable guidance there
      toast.error(
        errorObj?.response?.data?.message || errorObj?.response?.data?.error || 'Failed to delete system prompt'
      );
    }
  };

  // Parse tags/variables from the current input strings
  const parseTagsAndVariables = () => {
    const parsedTags = tagsInput
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
    const parsedVariables = variablesInput
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    return { parsedTags, parsedVariables };
  };

  const handleSubmit = async () => {
    const { parsedTags, parsedVariables } = parseTagsAndVariables();
    try {
      if (isCreating) {
        await createPrompt.mutateAsync({
          promptId,
          name,
          description,
          content,
          category,
          tags: parsedTags,
          variables: parsedVariables,
          enabled,
        });

        toast.success('System prompt created successfully');
        setIsCreating(false);
      } else if (editingPrompt) {
        await updatePrompt.mutateAsync({
          promptId: editingPrompt.promptId,
          name,
          description,
          content,
          category,
          tags: parsedTags,
          variables: parsedVariables,
          enabled,
        });

        toast.success('System prompt updated successfully');
        setOriginalContent(content); // Clear unsaved changes indicator
        setTagsInput(parsedTags.join(', '));
        setVariablesInput(parsedVariables.join(', '));
        setOriginalFields({
          name,
          description,
          category,
          tags: [...parsedTags],
          variables: [...parsedVariables],
          enabled,
        });
        // Reload version history to reflect changes
        await loadVersionHistory(editingPrompt.promptId);
      }

      refetch();
    } catch (err: unknown) {
      console.error('Error saving system prompt:', err);
      const errorObj = err as { response?: { data?: { error?: string } } };
      toast.error(errorObj?.response?.data?.error || 'Failed to save system prompt');
    }
  };

  const loadVersionHistory = async (loadPromptId: string) => {
    setIsLoadingHistory(true);
    setVersionHistory([]);
    // Don't reset selectedVersion - let handleEdit set it based on activeVersion
    setDefaultPromptData(null);
    try {
      const response = await api.get<{
        success: boolean;
        data: {
          history: IAdminSystemPromptHistory[];
          defaultPrompt: IAdminSystemPrompt | null;
          currentVersion: number | null;
        };
      }>(`/api/admin/system-prompts/${loadPromptId}/history`);
      if (response.data.success) {
        setVersionHistory(response.data.data.history);
        setDefaultPromptData(response.data.data.defaultPrompt);
      }
    } catch (err) {
      console.error('Error loading version history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // Select a version to view ('current', '0' = code default, or historical)
  const handleSelectVersion = (version: string) => {
    if (version === '0' && defaultPromptData) {
      setSelectedVersion('0');
      setContent(defaultPromptData.content);
      setOriginalContent(defaultPromptData.content);
      setName(defaultPromptData.name);
      setDescription(defaultPromptData.description);
      setCategory(defaultPromptData.category);
      setTagsInput(defaultPromptData.tags.join(', '));
      setVariablesInput(defaultPromptData.variables.join(', '));
      setOriginalFields({
        name: defaultPromptData.name,
        description: defaultPromptData.description,
        category: defaultPromptData.category,
        tags: [...defaultPromptData.tags],
        variables: [...defaultPromptData.variables],
        enabled: editingPrompt?.enabled ?? true,
      });
      return;
    }

    if (!editingPrompt) return;

    // Parse version number (for 'current', use editingPrompt.version)
    const versionNum = version === 'current' ? editingPrompt.version : parseInt(version, 10);

    const historyEntry = versionHistory.find(h => h.version === versionNum);

    if (historyEntry) {
      // Keep the selected version as requested (don't auto-convert to 'current')
      setSelectedVersion(version);
      setContent(historyEntry.content);
      setOriginalContent(historyEntry.content);
      setName(historyEntry.name);
      setDescription(historyEntry.description);
      setCategory(historyEntry.category);
      setTagsInput(historyEntry.tags.join(', '));
      setVariablesInput(historyEntry.variables.join(', '));
      setOriginalFields({
        name: historyEntry.name,
        description: historyEntry.description,
        category: historyEntry.category,
        tags: [...historyEntry.tags],
        variables: [...historyEntry.variables],
        enabled: editingPrompt.enabled,
      });
    } else if (version === 'current') {
      // Fallback: history not loaded yet, use editingPrompt data
      setSelectedVersion('current');
      setContent(editingPrompt.content);
      setOriginalContent(editingPrompt.content);
      setName(editingPrompt.name);
      setDescription(editingPrompt.description);
      setCategory(editingPrompt.category);
      setTagsInput(editingPrompt.tags.join(', '));
      setVariablesInput(editingPrompt.variables.join(', '));
      setOriginalFields({
        name: editingPrompt.name,
        description: editingPrompt.description,
        category: editingPrompt.category,
        tags: [...editingPrompt.tags],
        variables: [...editingPrompt.variables],
        enabled: editingPrompt.enabled,
      });
    }
  };

  // Switch the active version pointer. targetVersion: 0 = code default, 1+ = stored version
  const handleSwitchToVersion = async (targetVersion: number) => {
    if (!editingPrompt) return;

    try {
      const response = await api.post<{ success: boolean; message: string }>(
        `/api/admin/system-prompts/${editingPrompt.promptId}/switch-version`,
        { targetVersion }
      );

      if (response.data.success) {
        toast.success(response.data.message);
        // Reload version history and refetch to update UI
        await loadVersionHistory(editingPrompt.promptId);
        refetch();
      }
    } catch (err: unknown) {
      console.error('Error switching version:', err);
      const errorObj = err as { response?: { data?: { error?: string } } };
      toast.error(errorObj?.response?.data?.error || 'Failed to switch version');
    }
  };

  // Save edits to a version in place
  const handleSaveToVersion = async () => {
    if (!editingPrompt) return;

    const { parsedTags, parsedVariables } = parseTagsAndVariables();

    // When saving 'current', save to the latest version number (editingPrompt.version)
    // NOT getActiveVersion which could be 0 (code default)
    const versionToSave = selectedVersion === 'current' ? editingPrompt.version : Number(selectedVersion);

    try {
      const response = await api.post<{ success: boolean; message: string }>(
        `/api/admin/system-prompts/${editingPrompt.promptId}/save-version`,
        {
          version: versionToSave,
          content,
          name,
          description,
          category,
          tags: parsedTags,
          variables: parsedVariables,
          enabled,
        }
      );

      if (response.data.success) {
        toast.success(response.data.message);
        setOriginalContent(content); // Update original to match saved
        setTagsInput(parsedTags.join(', '));
        setVariablesInput(parsedVariables.join(', '));
        setOriginalFields({
          name,
          description,
          category,
          tags: [...parsedTags],
          variables: [...parsedVariables],
          enabled,
        });
        refetch();
      }
    } catch (err: unknown) {
      console.error('Error saving to version:', err);
      const errorObj = err as { response?: { data?: { error?: string } } };
      toast.error(errorObj?.response?.data?.error || 'Failed to save');
    }
  };

  const handleCreateNewVersion = async (setAsActive: boolean = true) => {
    if (!editingPrompt) return;

    const { parsedTags, parsedVariables } = parseTagsAndVariables();

    try {
      const response = await api.post<{ success: boolean; message: string; data: { version: number } }>(
        `/api/admin/system-prompts/${editingPrompt.promptId}/create-version`,
        {
          content,
          name,
          description,
          category,
          tags: parsedTags,
          variables: parsedVariables,
          enabled,
          setAsActive,
        }
      );

      if (response.data.success) {
        toast.success(response.data.message);
        setOriginalContent(content); // Clear unsaved changes indicator
        setTagsInput(parsedTags.join(', '));
        setVariablesInput(parsedVariables.join(', '));
        setOriginalFields({
          name,
          description,
          category,
          tags: [...parsedTags],
          variables: [...parsedVariables],
          enabled,
        });
        // Reload version history and select the new version
        await loadVersionHistory(editingPrompt.promptId);
        setSelectedVersion(String(response.data.data.version));
        refetch();
      }
    } catch (err: unknown) {
      console.error('Error creating new version:', err);
      const errorObj = err as { response?: { data?: { error?: string } } };
      toast.error(errorObj?.response?.data?.error || 'Failed to create version');
    }
  };

  // Save edits to a version and activate it in one step
  const handleSaveAndUseVersion = async () => {
    if (!editingPrompt) return;

    const { parsedTags, parsedVariables } = parseTagsAndVariables();
    const versionToSave = selectedVersion === 'current' ? editingPrompt.version : Number(selectedVersion);

    try {
      // First save the changes to this version
      const saveResponse = await api.post<{ success: boolean; message: string }>(
        `/api/admin/system-prompts/${editingPrompt.promptId}/save-version`,
        {
          version: versionToSave,
          content,
          name,
          description,
          category,
          tags: parsedTags,
          variables: parsedVariables,
          enabled,
        }
      );

      if (!saveResponse.data.success) {
        toast.error('Failed to save changes');
        return;
      }

      // Then switch to this version
      const switchResponse = await api.post<{ success: boolean; message: string }>(
        `/api/admin/system-prompts/${editingPrompt.promptId}/switch-version`,
        { targetVersion: versionToSave }
      );

      if (switchResponse.data.success) {
        toast.success(`Saved and activated v${versionToSave}`);
        setOriginalContent(content); // Clear unsaved changes indicator
        setTagsInput(parsedTags.join(', '));
        setVariablesInput(parsedVariables.join(', '));
        setOriginalFields({
          name,
          description,
          category,
          tags: [...parsedTags],
          variables: [...parsedVariables],
          enabled,
        });
        // Reload version history to reflect changes
        await loadVersionHistory(editingPrompt.promptId);
        refetch();
      }
    } catch (err: unknown) {
      console.error('Error saving and switching version:', err);
      const errorObj = err as { response?: { data?: { error?: string } } };
      toast.error(errorObj?.response?.data?.error || 'Failed to save and activate version');
    }
  };

  const getSuccessRate = (prompt: ISystemPromptWithMeta) => {
    if (!prompt.usageCount || prompt.usageCount === 0) return 'N/A';
    const rate = ((prompt.successCount || 0) / prompt.usageCount) * 100;
    if (isNaN(rate)) return 'N/A';
    return `${rate.toFixed(1)}%`;
  };

  const getPromptRole = (prompt: ISystemPromptWithMeta): 'system-message' | 'user-message' | null => {
    if (prompt.tags.includes('system-message')) return 'system-message';
    if (prompt.tags.includes('user-message')) return 'user-message';
    return null;
  };

  const getRoleBadge = (role: 'system-message' | 'user-message' | null) => {
    if (role === 'system-message') {
      return { label: 'System', tooltip: 'System message: sets AI behavior and constraints' };
    }
    if (role === 'user-message') {
      return { label: 'Main', tooltip: 'Main prompt: contains data and instructions' };
    }
    return null;
  };

  const hasFilters =
    categoryFilter !== 'all' || enabledFilter !== 'all' || sourceFilter !== 'all' || searchQuery !== '';

  const clearFilters = () => {
    setCategoryFilter('all');
    setEnabledFilter('all');
    setSourceFilter('all');
    setSearchQuery('');
  };

  const filterState: AdminListState = {
    query: searchQuery,
    view: '',
    filters: {
      [CATEGORY_FILTER]: categoryFilter === 'all' ? '' : categoryFilter,
      [SOURCE_FILTER]: sourceFilter === 'all' ? '' : sourceFilter,
      [STATUS_FILTER]: enabledFilter === 'all' ? '' : enabledFilter,
    },
  };

  const filters: AdminFilter[] = [
    { id: CATEGORY_FILTER, label: 'Category', options: categories.map(cat => ({ value: cat, label: cat })) },
    {
      id: SOURCE_FILTER,
      label: 'Source',
      options: [
        { value: 'code', label: 'Code' },
        { value: 'db', label: 'DB' },
      ],
    },
    {
      id: STATUS_FILTER,
      label: 'Status',
      options: [
        { value: 'true', label: 'Enabled' },
        { value: 'false', label: 'Disabled' },
      ],
    },
  ];

  const handleFilterChange = (patch: Partial<AdminListState>) => {
    if (patch.query !== undefined) setSearchQuery(patch.query);
    if (patch.filters) {
      setCategoryFilter(patch.filters[CATEGORY_FILTER] || 'all');
      setSourceFilter(toSourceFilter(patch.filters[SOURCE_FILTER]));
      setEnabledFilter(toEnabledFilter(patch.filters[STATUS_FILTER]));
    }
  };

  const closeEditor = () => {
    setEditingPrompt(null);
    setIsCreating(false);
  };

  const statusChip = (prompt: ISystemPromptWithMeta, testId?: string) => (
    <StatusChip
      tone={prompt.enabled ? 'good' : 'neutral'}
      label={prompt.enabled ? 'Enabled' : 'Disabled'}
      data-testid={testId}
    />
  );

  const columns: DataColumn<ISystemPromptWithMeta>[] = [
    {
      id: 'name',
      label: 'Name',
      width: '16rem',
      sortValue: prompt => prompt.name,
      render: prompt => {
        const roleBadge = getRoleBadge(getPromptRole(prompt));
        const tags = prompt.tags.filter(tag => !HIDDEN_TAGS.includes(tag)).slice(0, 2);
        return (
          <Stack gap={0.5} sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
              <TruncatedText text={prompt.name} testId={`system-prompt-name-${prompt.promptId}`} />
              {prompt.divergesFromCodeDefault && (
                <Tooltip
                  title="The code default for this prompt has changed since this override was authored. The override is now behind the code default."
                  placement="top"
                  arrow
                >
                  <Box component="span" sx={{ flexShrink: 0 }}>
                    <StatusChip
                      tone="warn"
                      label="Default updated"
                      data-testid={`system-prompt-diverged-${prompt.promptId}`}
                    />
                  </Box>
                </Tooltip>
              )}
            </Stack>
            {(roleBadge || tags.length > 0) && (
              <Stack direction="row" flexWrap="wrap" gap={0.5}>
                {roleBadge && (
                  <Tooltip title={roleBadge.tooltip} placement="top" arrow>
                    <Box component="span">
                      <StatusChip
                        tone="neutral"
                        label={roleBadge.label}
                        data-testid={`system-prompt-role-${prompt.promptId}`}
                      />
                    </Box>
                  </Tooltip>
                )}
                {tags.map(tag => (
                  <StatusChip key={tag} tone="neutral" label={tag} />
                ))}
              </Stack>
            )}
          </Stack>
        );
      },
    },
    {
      id: 'description',
      label: 'Description',
      render: prompt => (prompt.description ? <TruncatedText text={prompt.description} /> : <Dash />),
    },
    {
      id: 'category',
      label: 'Category',
      width: '9rem',
      sortValue: prompt => prompt.category,
      render: prompt => <StatusChip tone="neutral" label={prompt.category} />,
    },
    {
      id: 'source',
      label: 'Source',
      width: '5.5rem',
      sortValue: prompt => prompt.source,
      render: prompt => (
        <StatusChip
          tone="neutral"
          label={prompt.source === 'db' ? 'DB' : 'Code'}
          data-testid={`system-prompt-source-${prompt.promptId}`}
        />
      ),
    },
    {
      id: 'latest',
      label: 'Latest',
      width: '4.5rem',
      render: prompt => (prompt.source === 'db' ? `v${prompt.version}` : <Dash />),
    },
    {
      id: 'active',
      label: 'Active',
      width: '5rem',
      render: prompt => (prompt.source === 'db' ? formatVersion(getActiveVersion(prompt)) : <Dash />),
    },
    {
      id: 'usage',
      label: 'Usage',
      width: '5rem',
      numeric: true,
      sortValue: prompt => (prompt.source === 'db' ? (prompt.usageCount ?? 0) : -1),
      render: prompt => (prompt.source === 'db' ? (prompt.usageCount ?? 0).toLocaleString() : <Dash />),
    },
    {
      id: 'success',
      label: 'Success',
      width: '5rem',
      numeric: true,
      render: prompt => (prompt.source === 'db' ? getSuccessRate(prompt) : <Dash />),
    },
    {
      id: 'status',
      label: 'Status',
      width: '6rem',
      sortValue: prompt => (prompt.enabled ? 'Enabled' : 'Disabled'),
      render: prompt => statusChip(prompt, `system-prompt-status-${prompt.promptId}`),
    },
  ];

  return (
    <>
      {renderHeader({
        count: data ? total : undefined,
        refreshing: isFetching,
        onRefresh: () => void refetch(),
        onCreate: handleCreateNew,
      })}

      <Alert color="neutral" variant="soft" data-testid="system-prompts-info-banner">
        <Stack gap={0.5}>
          <Typography level="body-sm">
            Prompts load from code defaults. An override changes a prompt live, without a deploy: overrides are
            versioned and apply at once wherever the prompt is used.
          </Typography>
          <Typography level="body-sm">
            Many features pair two prompts: a System prompt that sets how the AI behaves and a Main prompt that carries
            the data and instructions. The chip under each name shows which role a prompt has.
          </Typography>
        </Stack>
      </Alert>

      <FilterBar
        state={filterState}
        filters={filters}
        searchLabel="Search name, description or tags"
        onChange={handleFilterChange}
      />

      <Stack gap={1} sx={{ minWidth: 0 }}>
        <UpdatingBar active={isFetching && !isLoading} testId="system-prompts-updating-bar" />
        <DataTable
          label="System prompts"
          testId="system-prompts-table"
          rows={prompts}
          columns={columns}
          getRowId={prompt => prompt.promptId}
          rowTestId={prompt => `system-prompt-row-${prompt.promptId}`}
          loading={isLoading}
          error={error ? 'Could not load system prompts.' : undefined}
          onRetry={() => void refetch()}
          pageResetKey={JSON.stringify(filterState)}
          empty={
            hasFilters ? (
              <EmptyState
                title="No prompts match these filters"
                action={
                  <Button variant="outlined" onClick={clearFilters} data-testid="system-prompts-empty-clear-btn">
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No system prompts yet"
                description="Check that the code defaults are defined, or create a prompt."
                action={
                  <Button variant="outlined" onClick={handleCreateNew} data-testid="system-prompts-empty-new-btn">
                    New prompt
                  </Button>
                }
              />
            )
          }
          rowActions={prompt => (
            <PromptRowMenu prompt={prompt} onView={handleView} onEdit={handleEdit} onDelete={setDeletingPrompt} />
          )}
          // Wide enough that every column keeps one line; below it the table scrolls inside its frame.
          minWidth="70rem"
          maxHeight="none"
        />
      </Stack>

      <AdminDialog
        open={deletingPrompt !== null}
        // Esc, the X and the backdrop wait for an in-flight delete, like the disabled Cancel.
        onClose={() => {
          if (!deletePrompt.isPending) setDeletingPrompt(null);
        }}
        title="Delete prompt"
        role="alertdialog"
        data-testid="system-prompt-delete-dialog"
      >
        <DialogContent>
          <Typography level="body-sm" component="div">
            Deletes <strong>{deletingPrompt?.name}</strong> (
            <Typography component="span" fontFamily="code">
              {deletingPrompt?.promptId}
            </Typography>
            ). It has no code default, so it is removed entirely. Its version history is kept.
          </Typography>
        </DialogContent>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => setDeletingPrompt(null)}
            disabled={deletePrompt.isPending}
            data-testid="system-prompt-delete-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            color="danger"
            loading={deletePrompt.isPending}
            data-testid="system-prompt-delete-confirm-btn"
            onClick={handleConfirmDelete}
          >
            Delete prompt
          </Button>
        </DialogFooter>
      </AdminDialog>

      <AdminDialog
        open={viewingPrompt !== null}
        onClose={() => setViewingPrompt(null)}
        title={viewingPrompt?.name ?? 'Prompt details'}
        width={900}
        data-testid="system-prompt-view-dialog"
      >
        {viewingPrompt && (
          <DialogContent sx={{ gap: 2 }}>
            <Field label="Prompt ID">
              <Typography level="body-sm" fontFamily="code" data-testid="system-prompt-view-id">
                {viewingPrompt.promptId}
              </Typography>
            </Field>

            <Field label="Description">
              <Typography level="body-sm">{viewingPrompt.description}</Typography>
            </Field>

            <Field label="Category">
              <StatusChip tone="neutral" label={viewingPrompt.category} />
            </Field>

            <Field label="Tags">
              <Stack direction="row" flexWrap="wrap" gap={0.5}>
                {viewingPrompt.tags.map(tag => (
                  <StatusChip key={tag} tone="neutral" label={tag} />
                ))}
              </Stack>
            </Field>

            <Field label="Supported variables">
              {viewingPrompt.variables.length > 0 ? (
                <Stack direction="row" flexWrap="wrap" gap={0.5}>
                  {viewingPrompt.variables.map(variable => (
                    <StatusChip key={variable} tone="neutral" label={`{{${variable}}}`} />
                  ))}
                </Stack>
              ) : (
                <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                  No variables
                </Typography>
              )}
            </Field>

            <Field
              label={
                viewingPrompt.hasOverride && getActiveVersion(viewingPrompt) === 0
                  ? 'Prompt content (code default)'
                  : 'Prompt content'
              }
            >
              <Sheet
                variant="outlined"
                sx={{ p: 2, borderRadius: 'sm', maxHeight: 400, overflow: 'auto', borderColor: 'admin.border' }}
              >
                <Typography level="body-sm" component="pre" sx={{ whiteSpace: 'pre-wrap', m: 0 }}>
                  {viewingPrompt.content}
                </Typography>
              </Sheet>
            </Field>

            <Divider />

            {/* Show different info based on whether this is code-only or has override */}
            {viewingPrompt.hasOverride ? (
              <>
                <Stack direction="row" gap={3} flexWrap="wrap">
                  <Field label="Active version">
                    <Typography level="body-sm">{formatVersion(getActiveVersion(viewingPrompt))}</Typography>
                  </Field>
                  <Field label="Latest stored">
                    <Typography level="body-sm">
                      v{viewingPrompt.version} - {new Date(viewingPrompt.updatedAt).toLocaleDateString()} (
                      {viewingPrompt.lastUpdatedByName})
                    </Typography>
                  </Field>
                  <Field label="Status">{statusChip(viewingPrompt, 'system-prompt-view-status')}</Field>
                  {getActiveVersion(viewingPrompt) !== 0 && (
                    <>
                      <Field label="Usage count">
                        <Typography level="body-sm">{(viewingPrompt.usageCount ?? 0).toLocaleString()}</Typography>
                      </Field>
                      <Field label="Success rate">
                        <Typography level="body-sm">{getSuccessRate(viewingPrompt)}</Typography>
                      </Field>
                    </>
                  )}
                </Stack>

                <Divider />

                <Stack direction="row" gap={3} flexWrap="wrap">
                  <Field label="Last updated by">
                    <Typography level="body-sm">{viewingPrompt.lastUpdatedByName}</Typography>
                  </Field>
                  <Field label="Last updated">
                    <Typography level="body-sm">{new Date(viewingPrompt.updatedAt).toLocaleString()}</Typography>
                  </Field>
                </Stack>

                {getActiveVersion(viewingPrompt) === 0 && (
                  <Alert variant="soft" color="neutral" size="sm">
                    App is using the code default. A stored override (v{viewingPrompt.version}) exists but is not
                    active.
                  </Alert>
                )}
              </>
            ) : (
              <Stack direction="row" gap={3} flexWrap="wrap">
                <Field label="Source">
                  <StatusChip tone="neutral" label="Code default" />
                </Field>
                <Field label="Status">{statusChip(viewingPrompt, 'system-prompt-view-status')}</Field>
              </Stack>
            )}
          </DialogContent>
        )}
      </AdminDialog>

      <AdminDialog
        open={!!editingPrompt || isCreating}
        onClose={closeEditor}
        title={isCreating ? 'New prompt' : 'Edit prompt'}
        width={1100}
        data-testid="system-prompt-edit-dialog"
      >
        <DialogContent sx={{ gap: 2 }}>
          {!isCreating && editingPrompt && (
            <Typography level="body-sm" component="div" sx={{ color: 'admin.inkMuted' }}>
              <Box component="strong" sx={{ color: 'admin.ink' }} data-testid="system-prompt-edit-name">
                {editingPrompt.name}
              </Box>{' '}
              (
              <Typography component="span" fontFamily="code">
                {editingPrompt.promptId}
              </Typography>
              )
            </Typography>
          )}

          {!isCreating && editingPrompt?.divergesFromCodeDefault && (
            <Alert
              variant="soft"
              color="warning"
              endDecorator={
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  disabled={!defaultPromptData}
                  onClick={() => handleSelectVersion('0')}
                  data-testid="system-prompt-view-default-btn"
                >
                  View code default
                </Button>
              }
            >
              <Typography level="body-sm">
                The <strong>code default</strong> for this prompt has changed since this override was authored, so the
                active override is now behind it. Compare against <strong>Default (code)</strong> in the version
                selector, then use <strong>Use default</strong> to adopt it, or edit and{' '}
                <strong>Save as new version</strong> to keep your customizations.
              </Typography>
            </Alert>
          )}

          {isCreating && (
            <FormControl>
              <FormLabel>Prompt ID</FormLabel>
              <Input
                value={promptId}
                onChange={e => setPromptId(e.target.value)}
                placeholder="sales_briefing_mode"
                slotProps={{ input: { 'data-testid': 'system-prompt-id-input' } }}
              />
              <Typography level="body-xs" sx={{ mt: 0.5 }}>
                Unique identifier (lowercase, underscores). Example: sales_briefing_mode
              </Typography>
            </FormControl>
          )}

          <FormControl>
            <FormLabel>Name</FormLabel>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Display name for admin UI"
              slotProps={{ input: { 'data-testid': 'system-prompt-name-input' } }}
            />
            <Typography level="body-xs" sx={{ mt: 0.5 }}>
              Clear, descriptive name for this prompt (e.g., &quot;Optimizer System Prompt&quot;)
            </Typography>
          </FormControl>

          <FormControl>
            <FormLabel>Description</FormLabel>
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this prompt do and where is it used?"
              slotProps={{ input: { 'data-testid': 'system-prompt-description-input' } }}
            />
            <Typography level="body-xs" sx={{ mt: 0.5 }}>
              Brief description of the prompt&apos;s purpose and context
            </Typography>
          </FormControl>

          <Box>
            <Stack
              direction="row"
              flexWrap="wrap"
              justifyContent="space-between"
              alignItems="center"
              gap={1}
              sx={{ mb: 0.5 }}
            >
              <Typography level="title-sm">Prompt content</Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                {/* Version selector - only show for DB overrides */}
                {!isCreating && editingPrompt && editingPrompt.hasOverride && (
                  <>
                    <HistoryIcon sx={{ fontSize: 18, color: 'admin.inkMuted' }} />
                    <Select
                      size="sm"
                      value={selectedVersion}
                      onChange={(_, value) => value && handleSelectVersion(value)}
                      sx={{ minWidth: { sm: 340 } }}
                      endDecorator={isLoadingHistory ? <CircularProgress size="sm" /> : null}
                      data-testid="system-prompt-version-select"
                    >
                      {/* Latest version option */}
                      <Option value="current">
                        v{editingPrompt.version} - {new Date(editingPrompt.updatedAt).toLocaleDateString()} (
                        {editingPrompt.lastUpdatedByName}) (Latest)
                        {getActiveVersion(editingPrompt!) === editingPrompt.version ? ' \u2713' : ''}
                        {hasActualEdits && selectedVersion === 'current' ? ' *' : ''}
                      </Option>
                      {/* Active version option (if historical and history not loaded yet) */}
                      {(() => {
                        const activeVer = getActiveVersion(editingPrompt!);
                        const isHistoricalActive = typeof activeVer === 'number' && activeVer !== editingPrompt.version;
                        const historyHasActive = versionHistory.some(h => h.version === activeVer);
                        // Show placeholder for active version if it's historical and not yet in loaded history
                        if (isHistoricalActive && !historyHasActive) {
                          return (
                            <Option value={String(activeVer)}>
                              v{activeVer} (active, loading...) {'\u2713'}
                            </Option>
                          );
                        }
                        return null;
                      })()}
                      {/* Historical versions */}
                      {versionHistory
                        .filter(h => Number(h.version) !== Number(editingPrompt.version))
                        // Deduplicate by version number (keep first/latest entry)
                        .filter((h, i, arr) => arr.findIndex(x => x.version === h.version) === i)
                        .map(h => (
                          <Option key={h.version} value={String(h.version)}>
                            v{h.version} - {new Date(h.createdAt).toLocaleDateString()} ({h.createdByName})
                            {getActiveVersion(editingPrompt!) === h.version ? ' \u2713' : ''}
                          </Option>
                        ))}
                      {/* Default code option - always show if activeVersion is 0, otherwise wait for data */}
                      {(getActiveVersion(editingPrompt!) === 0 || defaultPromptData) && (
                        <Option value="0">
                          Default (code){getActiveVersion(editingPrompt!) === 0 ? ' \u2713' : ''}
                        </Option>
                      )}
                    </Select>
                  </>
                )}
              </Stack>
            </Stack>
            <Textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              minRows={20}
              maxRows={30}
              placeholder="The actual prompt text. Use {{variableName}} for variable substitution..."
              slotProps={{ textarea: { 'data-testid': 'system-prompt-content-input' } }}
            />
            <Typography level="body-xs" sx={{ mt: 0.5 }}>
              Use <strong>{`{{variableName}}`}</strong> for variable substitution. Variables will be replaced at
              runtime.
            </Typography>
          </Box>

          <FormControl>
            <FormLabel>Category</FormLabel>
            <Select value={category} onChange={(_, value) => setCategory(value as string)}>
              <Option value="system">System</Option>
              <Option value="admin">Admin</Option>
              <Option value="automation">Automation</Option>
              <Option value="optihashi">OptiHashi</Option>
              <Option value="sales_intelligence">Sales Intelligence</Option>
            </Select>
            <Typography level="body-xs" sx={{ mt: 0.5 }}>
              Category for organization and filtering.
            </Typography>
          </FormControl>

          <FormControl>
            <FormLabel>Tags (comma-separated)</FormLabel>
            <Input
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              onBlur={() => {
                const parsed = tagsInput
                  .split(',')
                  .map(t => t.trim())
                  .filter(Boolean);
                setTagsInput(parsed.join(', '));
              }}
              placeholder="optimizer, scheduling, system"
              slotProps={{ input: { 'data-testid': 'system-prompt-tags-input' } }}
            />
            <Typography level="body-xs" sx={{ mt: 0.5 }}>
              Searchable tags to help find this prompt
            </Typography>
          </FormControl>

          <FormControl>
            <FormLabel>Variables (comma-separated)</FormLabel>
            <Input
              value={variablesInput}
              onChange={e => setVariablesInput(e.target.value)}
              onBlur={() => {
                const parsed = variablesInput
                  .split(',')
                  .map(v => v.trim())
                  .filter(Boolean);
                setVariablesInput(parsed.join(', '));
              }}
              placeholder="searchQuery, userName, companyName"
              slotProps={{ input: { 'data-testid': 'system-prompt-variables-input' } }}
            />
            <Typography level="body-xs" sx={{ mt: 0.5 }}>
              List variable names used in {`{{variable}}`} placeholders
            </Typography>
          </FormControl>

          <FormControl>
            <FormLabel>Status</FormLabel>
            <Select value={enabled ? 'enabled' : 'disabled'} onChange={(_, value) => setEnabled(value === 'enabled')}>
              <Option value="enabled">Enabled</Option>
              <Option value="disabled">Disabled</Option>
            </Select>
            <Typography level="body-xs" sx={{ mt: 0.5 }}>
              Disabled prompts won&apos;t be used by the system
            </Typography>
          </FormControl>

          <Alert variant="soft" color="neutral" data-testid="system-prompt-edit-status">
            <Typography level="body-sm">
              {isCreating
                ? 'Creating a new prompt will make it immediately available in production.'
                : selectedVersion === '0'
                  ? 'Viewing code default. Switch to use it or create a new version from it.'
                  : !editingPrompt
                    ? 'Loading...'
                    : getActiveVersion(editingPrompt!) === 0 && selectedVersion === 'current'
                      ? 'App is using code default. You are viewing the stored override. Create a new version to activate it.'
                      : !hasActualEdits
                        ? `Viewing ${formatVersion(selectedVersion === 'current' ? getActiveVersion(editingPrompt!) : Number(selectedVersion))}. Make changes to save or switch to use this version.`
                        : isViewingActiveVersion
                          ? 'You have unsaved changes. Save to update this version or create a new version.'
                          : `You have changes. Save to update ${formatVersion(Number(selectedVersion))} or create a new version.`}
            </Typography>
          </Alert>
        </DialogContent>

        <DialogFooter>
          <Button variant="outlined" onClick={closeEditor} data-testid="system-prompt-edit-cancel-btn">
            Cancel
          </Button>

          {isCreating ? (
            <Button
              startDecorator={<SaveIcon />}
              onClick={handleSubmit}
              loading={createPrompt.isPending}
              data-testid="system-prompt-create-btn"
            >
              Create prompt
            </Button>
          ) : editingPrompt && editingPrompt.hasOverride ? (
            <>
              {/* Switch to this version (if not already active, and no unsaved edits) */}
              {!isViewingActiveVersion && selectedVersion !== '0' && !hasActualEdits && (
                <Button
                  variant="outlined"
                  color="primary"
                  onClick={() =>
                    handleSwitchToVersion(
                      selectedVersion === 'current' ? editingPrompt.version : Number(selectedVersion)
                    )
                  }
                  data-testid="system-prompt-use-version-btn"
                >
                  Use v{selectedVersion === 'current' ? editingPrompt.version : selectedVersion}
                </Button>
              )}

              {/* Save + Use combined button (for non-active version with edits) */}
              {!isViewingActiveVersion && selectedVersion !== '0' && hasActualEdits && (
                <Button
                  startDecorator={<SaveIcon />}
                  onClick={handleSaveAndUseVersion}
                  data-testid="system-prompt-save-use-btn"
                >
                  Save + Use v{selectedVersion === 'current' ? editingPrompt.version : selectedVersion}
                </Button>
              )}

              {/* Switch to default (version 0) */}
              {selectedVersion === '0' && (
                <Button
                  variant="outlined"
                  color="primary"
                  onClick={() => handleSwitchToVersion(0)}
                  data-testid="system-prompt-use-default-btn"
                >
                  Use default
                </Button>
              )}

              {/* Save to current version (only when viewing the ACTIVE version with edits) */}
              {hasActualEdits && selectedVersion !== '0' && isViewingActiveVersion && (
                <Button
                  variant="soft"
                  startDecorator={<SaveIcon />}
                  onClick={handleSaveToVersion}
                  data-testid="system-prompt-save-version-btn"
                >
                  Save to{' '}
                  {formatVersion(selectedVersion === 'current' ? editingPrompt.version : Number(selectedVersion))}
                </Button>
              )}

              {/* Create new version (only if edited) */}
              {hasActualEdits && (
                <Button
                  variant="outlined"
                  startDecorator={<AddIcon />}
                  onClick={() => handleCreateNewVersion(true)}
                  data-testid="system-prompt-new-version-btn"
                >
                  Save as new version
                </Button>
              )}
            </>
          ) : (
            /* No override yet - create first version */
            <Button
              startDecorator={<SaveIcon />}
              onClick={handleSubmit}
              loading={updatePrompt.isPending}
              data-testid="system-prompt-create-override-btn"
            >
              Create override (v1)
            </Button>
          )}
        </DialogFooter>
      </AdminDialog>
    </>
  );
};

export default SystemPromptEditor;
