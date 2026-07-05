import React, { useState, useEffect, useCallback } from 'react';
import {
  Sheet,
  Stack,
  Typography,
  Button,
  Alert,
  FormControl,
  FormLabel,
  Select,
  Option,
  Input,
  IconButton,
  Tooltip,
  Modal,
  ModalDialog,
  ModalClose,
  Table,
  Chip,
  Textarea,
  CircularProgress,
  Box,
  Divider,
} from '@mui/joy';
import {
  Edit as EditIcon,
  Refresh as RefreshIcon,
  Save as SaveIcon,
  Search as SearchIcon,
  ChatBubble as PromptIcon,
  Visibility as VisibilityIcon,
  Add as AddIcon,
  History as HistoryIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import { useSystemPrompts, useUpdateSystemPrompt, useCreateSystemPrompt } from '@client/app/hooks/data/systemPrompts';
import { IAdminSystemPrompt, IAdminSystemPromptHistory } from '@bike4mind/common';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';

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

const SystemPromptEditor: React.FC = () => {
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'true' | 'false'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'code' | 'db'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingPrompt, setEditingPrompt] = useState<ISystemPromptWithMeta | null>(null);
  const [viewingPrompt, setViewingPrompt] = useState<ISystemPromptWithMeta | null>(null);
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

  const prompts = (data?.data || []) as ISystemPromptWithMeta[];
  const total = data?.count || 0;

  const categories = ['all', ...Array.from(new Set(prompts.map(p => p.category)))];

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
      return {
        label: 'System',
        color: 'warning' as const,
        tooltip: 'System Message: Sets AI behavior and constraints',
      };
    }
    if (role === 'user-message') {
      return { label: 'Main', color: 'primary' as const, tooltip: 'Main Prompt: Contains data and instructions' };
    }
    return null;
  };

  return (
    <Sheet sx={{ p: 2, width: '100%', overflow: 'auto' }}>
      {error && (
        <Alert variant="soft" color="danger" sx={{ mb: 2 }}>
          <Typography level="body-sm">
            <strong>Error loading prompts:</strong> {error instanceof Error ? error.message : JSON.stringify(error)}
          </Typography>
        </Alert>
      )}

      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <PromptIcon sx={{ fontSize: 28, color: 'primary.500' }} />
          <Typography level="h2">System Prompts</Typography>
          <Chip size="sm" variant="soft">
            {total} {total === 1 ? 'prompt' : 'prompts'}
          </Chip>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button startDecorator={<AddIcon />} onClick={handleCreateNew}>
            Create New
          </Button>
          <Button startDecorator={<RefreshIcon />} variant="outlined" onClick={() => refetch()} loading={isFetching}>
            Refresh
          </Button>
        </Stack>
      </Stack>

      {/* Info Alert */}
      <Alert variant="soft" color="primary" sx={{ mb: 3 }}>
        <Typography level="body-sm">
          <strong>Hybrid Prompt System:</strong> System prompts load from code defaults. Create a database override to
          edit prompts live without deployments. Overrides are versioned and take effect immediately across all features
          using them.
        </Typography>
        <Typography level="body-sm" sx={{ mt: 1 }}>
          <strong>Two-Prompt Pattern:</strong> Many features use two prompts together: a{' '}
          <Chip size="sm" variant="soft" color="warning" sx={{ mx: 0.5 }}>
            System
          </Chip>{' '}
          message (sets AI behavior) and a{' '}
          <Chip size="sm" variant="soft" color="primary" sx={{ mx: 0.5 }}>
            Main
          </Chip>{' '}
          prompt (provides data and instructions). Look for these badges to identify prompt roles.
        </Typography>
      </Alert>

      {/* Filters */}
      <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
        <FormControl sx={{ minWidth: 200 }}>
          <FormLabel>Category</FormLabel>
          <Select value={categoryFilter} onChange={(_, value) => setCategoryFilter(value as string)}>
            {categories.map(cat => (
              <Option key={cat} value={cat}>
                {cat === 'all' ? 'All Categories' : cat}
              </Option>
            ))}
          </Select>
        </FormControl>

        <FormControl sx={{ minWidth: 120 }}>
          <FormLabel>Status</FormLabel>
          <Select value={enabledFilter} onChange={(_, value) => setEnabledFilter(value as 'all' | 'true' | 'false')}>
            <Option value="all">All</Option>
            <Option value="true">Enabled</Option>
            <Option value="false">Disabled</Option>
          </Select>
        </FormControl>

        <FormControl sx={{ minWidth: 120 }}>
          <FormLabel>Source</FormLabel>
          <Select value={sourceFilter} onChange={(_, value) => setSourceFilter(value as 'all' | 'code' | 'db')}>
            <Option value="all">All</Option>
            <Option value="code">Code</Option>
            <Option value="db">DB</Option>
          </Select>
        </FormControl>

        <FormControl sx={{ flexGrow: 1 }}>
          <FormLabel>Search</FormLabel>
          <Input
            placeholder="Search by name, description, or tags..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            startDecorator={<SearchIcon />}
          />
        </FormControl>
      </Stack>

      {/* Prompts Table */}
      <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto', maxHeight: '65vh' }}>
        <Table stickyHeader hoverRow>
          <thead>
            <tr>
              <th style={{ width: '20%' }}>Name</th>
              <th style={{ width: '25%' }}>Description</th>
              <th style={{ width: '9%' }}>Category</th>
              <th style={{ width: '6%' }}>Source</th>
              <th style={{ width: '6%' }}>Latest</th>
              <th style={{ width: '8%' }}>Active</th>
              <th style={{ width: '6%' }}>Usage</th>
              <th style={{ width: '6%' }}>Success</th>
              <th style={{ width: '7%' }}>Status</th>
              <th style={{ width: '7%' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading || isFetching ? (
              <tr>
                <td colSpan={10}>
                  <Stack direction="column" alignItems="center" spacing={2} sx={{ py: 4 }}>
                    <CircularProgress />
                    <Typography level="body-lg" color="neutral">
                      {isLoading ? 'Loading system prompts...' : 'Refreshing...'}
                    </Typography>
                  </Stack>
                </td>
              </tr>
            ) : prompts.length === 0 ? (
              <tr>
                <td colSpan={10}>
                  <Stack direction="column" alignItems="center" spacing={2} sx={{ py: 4 }}>
                    <Typography level="body-lg" color="neutral">
                      {searchQuery
                        ? 'No prompts found matching your search.'
                        : 'No prompts loaded. Check that default prompts are defined.'}
                    </Typography>
                  </Stack>
                </td>
              </tr>
            ) : (
              prompts.map(prompt => {
                const role = getPromptRole(prompt);
                const roleBadge = getRoleBadge(role);

                return (
                  <tr key={prompt.promptId}>
                    <td>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap' }}>
                        <Tooltip title={prompt.name} placement="top">
                          <Typography level="body-sm" fontWeight="lg" noWrap>
                            {prompt.name}
                          </Typography>
                        </Tooltip>
                        {prompt.hasOverride && (
                          <Chip size="sm" variant="solid" color="primary">
                            Override
                          </Chip>
                        )}
                        {prompt.divergesFromCodeDefault && (
                          <Tooltip
                            title="The code default for this prompt has changed since this override was authored. The override is now behind the code default."
                            placement="top"
                            arrow
                          >
                            <Chip size="sm" variant="soft" color="warning" startDecorator={<WarningIcon />}>
                              Default updated
                            </Chip>
                          </Tooltip>
                        )}
                      </Stack>
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                        {/* Role badge with tooltip */}
                        {roleBadge && (
                          <Tooltip title={roleBadge.tooltip} placement="top" arrow>
                            <Chip size="sm" variant="soft" color={roleBadge.color}>
                              {roleBadge.label}
                            </Chip>
                          </Tooltip>
                        )}
                        {/* Show other tags (skip role tags) */}
                        {prompt.tags
                          .filter(
                            tag => !['system-message', 'user-message', 'main-prompt', 'behavior-config'].includes(tag)
                          )
                          .slice(0, 2)
                          .map(tag => (
                            <Chip key={tag} size="sm" variant="outlined">
                              {tag}
                            </Chip>
                          ))}
                      </Stack>
                    </td>
                    <td>
                      <Tooltip title={prompt.description} placement="top" arrow>
                        <Typography level="body-sm" noWrap>
                          {prompt.description}
                        </Typography>
                      </Tooltip>
                    </td>
                    <td>
                      <Chip size="sm" variant="soft">
                        {prompt.category}
                      </Chip>
                    </td>
                    <td>
                      <Chip size="sm" variant="outlined" color={prompt.source === 'db' ? 'success' : 'neutral'}>
                        {prompt.source === 'db' ? 'DB' : 'Code'}
                      </Chip>
                    </td>
                    <td>
                      <Typography level="body-sm">{prompt.source === 'db' ? `v${prompt.version}` : '-'}</Typography>
                    </td>
                    <td>
                      {prompt.source === 'db' ? (
                        <Chip size="sm" variant="soft" color={getActiveVersion(prompt) === 0 ? 'neutral' : 'primary'}>
                          {formatVersion(getActiveVersion(prompt))}
                        </Chip>
                      ) : (
                        <Typography level="body-sm">-</Typography>
                      )}
                    </td>
                    <td>
                      <Typography level="body-sm">{prompt.source === 'db' ? (prompt.usageCount ?? 0) : '-'}</Typography>
                    </td>
                    <td>
                      <Typography
                        level="body-sm"
                        color={
                          prompt.source === 'code' || getSuccessRate(prompt) === 'N/A'
                            ? 'neutral'
                            : parseFloat(getSuccessRate(prompt)) >= 90
                              ? 'success'
                              : 'danger'
                        }
                      >
                        {prompt.source === 'db' ? getSuccessRate(prompt) : '-'}
                      </Typography>
                    </td>
                    <td>
                      <Chip color={prompt.enabled ? 'success' : 'neutral'} variant="soft" size="sm">
                        {prompt.enabled ? 'Enabled' : 'Disabled'}
                      </Chip>
                    </td>
                    <td>
                      <Stack direction="row" spacing={0.5}>
                        <Tooltip title="View details">
                          <IconButton size="sm" variant="plain" onClick={() => handleView(prompt)}>
                            <VisibilityIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={prompt.hasOverride ? 'Edit override' : 'Create override'}>
                          <IconButton size="sm" variant="plain" onClick={() => handleEdit(prompt)}>
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Sheet>

      {/* View Modal */}
      <Modal open={!!viewingPrompt} onClose={() => setViewingPrompt(null)}>
        <ModalDialog
          sx={{
            minWidth: 900,
            maxWidth: '90vw',
            width: 1100,
            maxHeight: '90vh',
            overflow: 'auto',
            resize: 'horizontal',
          }}
        >
          <ModalClose />
          <Typography level="h4">{viewingPrompt?.name}</Typography>

          {viewingPrompt && (
            <Stack spacing={2} sx={{ mt: 2 }}>
              <Box>
                <Typography level="title-sm" color="neutral">
                  Prompt ID
                </Typography>
                <Typography level="body-md" fontFamily="monospace">
                  {viewingPrompt.promptId}
                </Typography>
              </Box>

              <Box>
                <Typography level="title-sm" color="neutral">
                  Description
                </Typography>
                <Typography level="body-sm">{viewingPrompt.description}</Typography>
              </Box>

              <Box>
                <Typography level="title-sm" color="neutral">
                  Category
                </Typography>
                <Chip size="sm" variant="soft">
                  {viewingPrompt.category}
                </Chip>
              </Box>

              <Box>
                <Typography level="title-sm" color="neutral">
                  Tags
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                  {viewingPrompt.tags.map(tag => (
                    <Chip key={tag} size="sm" variant="outlined">
                      {tag}
                    </Chip>
                  ))}
                </Stack>
              </Box>

              <Box>
                <Typography level="title-sm" color="neutral">
                  Supported Variables
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                  {viewingPrompt.variables.length > 0 ? (
                    viewingPrompt.variables.map(variable => (
                      <Chip key={variable} size="sm" variant="soft" color="primary">
                        {`{{${variable}}}`}
                      </Chip>
                    ))
                  ) : (
                    <Typography level="body-xs" color="neutral">
                      No variables
                    </Typography>
                  )}
                </Stack>
              </Box>

              <Box>
                <Typography level="title-sm" color="neutral" sx={{ mb: 0.5 }}>
                  Prompt Content{' '}
                  {viewingPrompt.hasOverride && getActiveVersion(viewingPrompt) === 0 ? '(Code Default)' : ''}
                </Typography>
                <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm', maxHeight: 400, overflow: 'auto' }}>
                  <Typography level="body-sm" component="pre" sx={{ whiteSpace: 'pre-wrap' }}>
                    {viewingPrompt.content}
                  </Typography>
                </Sheet>
              </Box>

              <Divider />

              {/* Show different info based on whether this is code-only or has override */}
              {viewingPrompt.hasOverride ? (
                <>
                  <Stack direction="row" spacing={3} flexWrap="wrap">
                    <Box>
                      <Typography level="title-sm" color="neutral">
                        Active Version
                      </Typography>
                      <Chip
                        size="sm"
                        variant="soft"
                        color={getActiveVersion(viewingPrompt) === 0 ? 'neutral' : 'primary'}
                      >
                        {formatVersion(getActiveVersion(viewingPrompt))}
                      </Chip>
                    </Box>
                    <Box>
                      <Typography level="title-sm" color="neutral">
                        Latest Stored
                      </Typography>
                      <Typography level="body-sm">
                        v{viewingPrompt.version} - {new Date(viewingPrompt.updatedAt).toLocaleDateString()} (
                        {viewingPrompt.lastUpdatedByName})
                      </Typography>
                    </Box>
                    <Box>
                      <Typography level="title-sm" color="neutral">
                        Status
                      </Typography>
                      <Chip color={viewingPrompt.enabled ? 'success' : 'neutral'} variant="soft" size="sm">
                        {viewingPrompt.enabled ? 'Enabled' : 'Disabled'}
                      </Chip>
                    </Box>
                    {getActiveVersion(viewingPrompt) !== 0 && (
                      <>
                        <Box>
                          <Typography level="title-sm" color="neutral">
                            Usage Count
                          </Typography>
                          <Typography level="body-md">{viewingPrompt.usageCount ?? 0}</Typography>
                        </Box>
                        <Box>
                          <Typography level="title-sm" color="neutral">
                            Success Rate
                          </Typography>
                          <Typography level="body-md">{getSuccessRate(viewingPrompt)}</Typography>
                        </Box>
                      </>
                    )}
                  </Stack>

                  <Divider />

                  <Stack direction="row" spacing={3}>
                    <Box>
                      <Typography level="title-sm" color="neutral">
                        Last Updated By
                      </Typography>
                      <Typography level="body-sm">{viewingPrompt.lastUpdatedByName}</Typography>
                    </Box>
                    <Box>
                      <Typography level="title-sm" color="neutral">
                        Last Updated
                      </Typography>
                      <Typography level="body-sm">{new Date(viewingPrompt.updatedAt).toLocaleString()}</Typography>
                    </Box>
                  </Stack>

                  {getActiveVersion(viewingPrompt) === 0 && (
                    <Alert variant="soft" color="neutral" size="sm">
                      App is using the code default. A stored override (v{viewingPrompt.version}) exists but is not
                      active.
                    </Alert>
                  )}
                </>
              ) : (
                <Stack direction="row" spacing={3}>
                  <Box>
                    <Typography level="title-sm" color="neutral">
                      Source
                    </Typography>
                    <Chip size="sm" variant="soft" color="neutral">
                      Code Default
                    </Chip>
                  </Box>
                  <Box>
                    <Typography level="title-sm" color="neutral">
                      Status
                    </Typography>
                    <Chip color={viewingPrompt.enabled ? 'success' : 'neutral'} variant="soft" size="sm">
                      {viewingPrompt.enabled ? 'Enabled' : 'Disabled'}
                    </Chip>
                  </Box>
                </Stack>
              )}
            </Stack>
          )}
        </ModalDialog>
      </Modal>

      {/* Edit/Create Modal */}
      <Modal
        open={!!editingPrompt || isCreating}
        onClose={() => {
          setEditingPrompt(null);
          setIsCreating(false);
        }}
      >
        <ModalDialog
          sx={{
            minWidth: 900,
            maxWidth: '95vw',
            width: 1100,
            maxHeight: '90vh',
            overflow: 'hidden',
            resize: 'both',
          }}
        >
          <ModalClose />
          <Typography level="h4">{isCreating ? 'Create New Prompt' : `Edit Prompt: ${editingPrompt?.name}`}</Typography>

          {!isCreating && editingPrompt?.divergesFromCodeDefault && (
            <Alert
              variant="soft"
              color="warning"
              startDecorator={<WarningIcon />}
              sx={{ mt: 1.5 }}
              endDecorator={
                <Button
                  size="sm"
                  variant="outlined"
                  color="warning"
                  disabled={!defaultPromptData}
                  onClick={() => handleSelectVersion('0')}
                >
                  View code default
                </Button>
              }
            >
              <Typography level="body-sm">
                The <strong>code default</strong> for this prompt has changed since this override was authored — the
                active override is now behind it. Compare against <strong>Default (Code)</strong> in the version
                selector, then use <strong>Use Default</strong> to adopt it, or edit and{' '}
                <strong>Save as New Version</strong> to keep your customizations.
              </Typography>
            </Alert>
          )}

          <Stack direction="row" spacing={0} sx={{ mt: 2, height: 'calc(90vh - 120px)', minHeight: 400 }}>
            {/* Edit Form */}
            <Stack spacing={2} sx={{ flex: 1, minWidth: 0, overflow: 'auto', pr: 2 }}>
              {isCreating && (
                <FormControl>
                  <FormLabel>Prompt ID</FormLabel>
                  <Input
                    value={promptId}
                    onChange={e => setPromptId(e.target.value)}
                    placeholder="sales_briefing_mode"
                  />
                  <Typography level="body-xs" sx={{ mt: 0.5 }}>
                    Unique identifier (lowercase, underscores). Example: sales_briefing_mode
                  </Typography>
                </FormControl>
              )}

              <FormControl>
                <FormLabel>Name</FormLabel>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Display name for admin UI" />
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
                />
                <Typography level="body-xs" sx={{ mt: 0.5 }}>
                  Brief description of the prompt&apos;s purpose and context
                </Typography>
              </FormControl>

              <Box>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography level="title-sm">Prompt Content</Typography>
                  <Stack direction="row" spacing={1} alignItems="center">
                    {/* Version selector - only show for DB overrides */}
                    {!isCreating && editingPrompt && editingPrompt.hasOverride && (
                      <>
                        <HistoryIcon sx={{ fontSize: 18, color: 'neutral.500' }} />
                        <Select
                          size="sm"
                          value={selectedVersion}
                          onChange={(_, value) => value && handleSelectVersion(value)}
                          sx={{ minWidth: 340 }}
                          endDecorator={isLoadingHistory ? <CircularProgress size="sm" /> : null}
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
                            const isHistoricalActive =
                              typeof activeVer === 'number' && activeVer !== editingPrompt.version;
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
                              Default (Code){getActiveVersion(editingPrompt!) === 0 ? ' \u2713' : ''}
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
                />
                <Typography level="body-xs" sx={{ mt: 0.5 }}>
                  List variable names used in {`{{variable}}`} placeholders
                </Typography>
              </FormControl>

              <FormControl>
                <FormLabel>Status</FormLabel>
                <Select
                  value={enabled ? 'enabled' : 'disabled'}
                  onChange={(_, value) => setEnabled(value === 'enabled')}
                >
                  <Option value="enabled">Enabled</Option>
                  <Option value="disabled">Disabled</Option>
                </Select>
                <Typography level="body-xs" sx={{ mt: 0.5 }}>
                  Disabled prompts won&apos;t be used by the system
                </Typography>
              </FormControl>

              <Alert
                variant="soft"
                color={selectedVersion === '0' ? 'primary' : hasActualEdits ? 'warning' : 'neutral'}
              >
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

              <Stack direction="row" spacing={2} justifyContent="flex-end" flexWrap="wrap">
                <Button
                  variant="outlined"
                  onClick={() => {
                    setEditingPrompt(null);
                    setIsCreating(false);
                  }}
                >
                  Cancel
                </Button>

                {isCreating ? (
                  <Button startDecorator={<SaveIcon />} onClick={handleSubmit} loading={createPrompt.isPending}>
                    Create Prompt
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
                      >
                        Use v{selectedVersion === 'current' ? editingPrompt.version : selectedVersion}
                      </Button>
                    )}

                    {/* Save + Use combined button (for non-active version with edits) */}
                    {!isViewingActiveVersion && selectedVersion !== '0' && hasActualEdits && (
                      <Button startDecorator={<SaveIcon />} onClick={handleSaveAndUseVersion}>
                        Save + Use v{selectedVersion === 'current' ? editingPrompt.version : selectedVersion}
                      </Button>
                    )}

                    {/* Switch to default (version 0) */}
                    {selectedVersion === '0' && (
                      <Button variant="outlined" color="primary" onClick={() => handleSwitchToVersion(0)}>
                        Use Default
                      </Button>
                    )}

                    {/* Save to current version (only when viewing the ACTIVE version with edits) */}
                    {hasActualEdits && selectedVersion !== '0' && isViewingActiveVersion && (
                      <Button variant="soft" startDecorator={<SaveIcon />} onClick={handleSaveToVersion}>
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
                      >
                        Save as New Version
                      </Button>
                    )}
                  </>
                ) : (
                  /* No override yet - create first version */
                  <Button startDecorator={<SaveIcon />} onClick={handleSubmit} loading={updatePrompt.isPending}>
                    Create Override (v1)
                  </Button>
                )}
              </Stack>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>
    </Sheet>
  );
};

export default SystemPromptEditor;
