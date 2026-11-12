import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import {
  Alert,
  Box,
  Button,
  Chip,
  Checkbox,
  Input,
  Option,
  Select,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/joy';
import { LLMModelConfig, ModelBackend, normalizeEntitlementKey, isOAuthSourceTag } from '@bike4mind/common';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import {
  useLLMModelConfigurationsWithDefaults,
  useSaveLLMModelConfigurations,
} from '@client/app/hooks/data/llmModelConfig';
import {
  modelAccessChanges,
  committedModelSnapshot,
  retainPendingModelEdits,
  type LoadedModelConfiguration,
} from '@client/app/hooks/data/modelAccessDraft';
import { useGetUsers } from '@client/app/hooks/data/user';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { KNOWN_ENTITLEMENT_KEYS } from '@bike4mind/server-utils/lib/entitlements/registry';
import {
  ActionDialog,
  AdminPageHeader,
  AdminSearchInput,
  BulkActionBar,
  DataTable,
  EmptyState,
  ErrorState,
  FilterChip,
  LoadingState,
  SaveBar,
  StatStrip,
  StatTile,
  UnsavedChangesGuard,
  type AdminSelection,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP, adminFocusScope } from './shared/adminStyles';
import { useAdminModal } from './useAdminModal';
import { adminTabToSlug } from './adminTabSlugs';
import { adminSearchForTab } from './adminTabParams';

// Available user tags for permissions (used in table display)
// 'admin' access is handled via user.isAdmin property, not tags
const AVAILABLE_USER_TAGS = [
  { value: 'developer', label: 'Developer' },
  { value: 'customer', label: 'Customer' },
];

const getTagInfo = (tagValue: string) =>
  AVAILABLE_USER_TAGS.find(tag => tag.value === tagValue) ?? {
    value: tagValue,
    label: tagValue.charAt(0).toUpperCase() + tagValue.slice(1),
  };

// ModelInfo has no `vendor` field, but discovery-sourced rows may carry one - read it
// structurally so the search covers it without asserting it onto the shared type.
const getModelVendor = (model: LLMModelConfig): string => {
  const vendor = (model as { vendor?: unknown }).vendor;
  return typeof vendor === 'string' ? vendor : '';
};

const SEARCH_DEBOUNCE_MS = 250;

// `query` must already be lowercased and trimmed.
const matchesSearch = (model: LLMModelConfig, query: string): boolean =>
  [model.id, model.name, model.backend, getModelVendor(model)].some(field => field.toLowerCase().includes(query));

const TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'image', label: 'Image' },
];
const BACKEND_OPTIONS = Object.values(ModelBackend).map(backend => ({ value: backend, label: backend }));
const STATUS_OPTIONS = [
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

// Must match the checkbox column DataTable adds in front of `columns` (shared/DataTable.tsx).
const SELECTION_COLUMN_REM = 2.75;
// Joy header cells never wrap (nowrap + ellipsis), so a tag or entitlement column is as wide as its
// 12 px label: about half a rem a character, plus the 12 px cell padding on each side.
const accessColumnRem = (label: string): number => Math.max(5, label.length * 0.5 + 1.5);

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const formatDate = (date?: Date) => (date ? DATE_FORMAT.format(date) : '-');

type ModelDates = Record<string, { createdAt?: Date; updatedAt?: Date }>;
type Snapshot = { models: LoadedModelConfiguration[]; dates: ModelDates };

const sameMembers = (left: readonly string[] = [], right: readonly string[] = []) =>
  left.length === right.length && [...left].sort().join('\n') === [...right].sort().join('\n');

// Compares only the fields this page edits, so toggling a value back counts as no change.
const isUnchanged = (current: LLMModelConfig, loaded: LLMModelConfig | undefined) =>
  !!loaded &&
  current.enabled === loaded.enabled &&
  current.rank === loaded.rank &&
  (current.fallbackModel || '') === (loaded.fallbackModel || '') &&
  sameMembers(current.allowedUserTags, loaded.allowedUserTags) &&
  sameMembers(current.allowedEntitlements, loaded.allowedEntitlements);

// Same rule as the admin settings guard (SettingsDraftProvider): another page or another admin tab.
const isLeavingTab = (current: { pathname: string; search: object }, next: { pathname: string; search: object }) =>
  current.pathname !== next.pathname ||
  ('tab' in current.search ? current.search.tab : undefined) !== ('tab' in next.search ? next.search.tab : undefined);

const LLMDashboardTab: React.FC = () => {
  const router = useRouter();
  const {
    data: modelInfos,
    isPending: modelInfoPending,
    error: modelInfoError,
    refetch: refetchModelInfo,
  } = useModelInfo();
  // Pass the query's own pending state: inferring it from missing data would report a failed
  // model-info fetch as loading forever and hide the error.
  const {
    data: models,
    isLoading: configLoading,
    error: configError,
    refetch: refetchConfigurations,
  } = useLLMModelConfigurationsWithDefaults(modelInfos, modelInfoPending);
  const { data: usersData, isLoading: usersLoading } = useGetUsers({
    page: 1,
    limit: 1000, // Get all users to extract their tags
  });
  const error = modelInfoError ?? configError;
  const [localModels, setLocalModels] = useState<LoadedModelConfiguration[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [confirmAdminOnly, setConfirmAdminOnly] = useState(false);
  const [saved, setSaved] = useState<Snapshot>({ models: [], dates: {} });
  const [initialized, setInitialized] = useState(false);
  const [filterType, setFilterType] = useState<string>();
  const [filterBackend, setFilterBackend] = useState<string>();
  const [filterStatus, setFilterStatus] = useState<string>();
  // Debounced: discovery grows this catalog, so every keystroke would otherwise
  // re-filter and re-sort a list that keeps getting longer.
  const {
    value: searchQuery,
    debouncedValue: debouncedSearchQuery,
    setValue: setSearchQuery,
    setValueImmediately: resetSearchQuery,
  } = useDebounceValue('', SEARCH_DEBOUNCE_MS);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [modelDates, setModelDates] = useState<ModelDates>({});
  const savingRef = useRef<Snapshot | null>(null);

  const saveLLMConfigurations = useSaveLLMModelConfigurations(result => {
    const snapshot = savingRef.current;
    if (!snapshot) return;
    const committed = committedModelSnapshot(snapshot.models, result);
    setSaved({ ...snapshot, models: committed });
    setLocalModels(current => retainPendingModelEdits(current, snapshot.models, committed));
    savingRef.current = null;
  });

  // Initialize local models when configurations are loaded
  useEffect(() => {
    if (models && models.length > 0 && !initialized) {
      setInitialized(true);

      // Initialize dates for models (using current date as placeholder)
      // In a real implementation, these would come from the backend
      const initialDates: ModelDates = {};
      models.forEach((model, index) => {
        // Create staggered dates for demo purposes
        // In production, these would be actual timestamps from the database
        const baseDate = new Date();
        baseDate.setDate(baseDate.getDate() - (models.length - index) * 7);
        initialDates[model.id] = {
          createdAt: new Date(baseDate),
          updatedAt: new Date(baseDate.getTime() + Math.random() * 7 * 24 * 60 * 60 * 1000),
        };
      });
      setLocalModels(models);
      setModelDates(initialDates);
      setSaved({ models, dates: initialDates });
    }
  }, [models, initialized]);

  // Until the init effect above copies the models in, localModels is still empty: show loading, not
  // an empty table and a 0/0/0/0 strip.
  const isLoading = configLoading || usersLoading || (models.length > 0 && !initialized);

  const filteredModels = useMemo(() => {
    const search = debouncedSearchQuery.trim().toLowerCase();
    return localModels.filter(model => {
      if (filterType && model.type !== filterType) return false;
      if (filterBackend && model.backend !== filterBackend) return false;
      if (filterStatus === 'enabled' && !model.enabled) return false;
      if (filterStatus === 'disabled' && model.enabled) return false;
      if (model.type === 'speech-to-text') return false;
      if (search && !matchesSearch(model, search)) return false;
      return true;
    });
  }, [localModels, filterType, filterBackend, filterStatus, debouncedSearchQuery]);

  const hasFilters = Boolean(filterType || filterBackend || filterStatus || debouncedSearchQuery.trim());
  const filterKey = JSON.stringify([filterType, filterBackend, filterStatus, debouncedSearchQuery]);

  const selectedIdSet = useMemo(() => new Set(selectedModelIds), [selectedModelIds]);
  // The selection survives filter changes (narrowing a search must not silently
  // throw work away), so every bulk action is scoped to selected AND visible.
  const selectedFilteredIds = useMemo(
    () => filteredModels.filter(model => selectedIdSet.has(model.id)).map(model => model.id),
    [filteredModels, selectedIdSet]
  );
  const hiddenSelectedCount = selectedModelIds.length - selectedFilteredIds.length;

  const changedCount = useMemo(() => {
    const loadedById = new Map(saved.models.map(model => [model.id, model]));
    return localModels.filter(model => !isUnchanged(model, loadedById.get(model.id))).length;
  }, [localModels, saved]);

  const dirty = changedCount > 0 || saveLLMConfigurations.isPending;
  // Same guard as SettingsDraftProvider; keep the two in sync. A sidebar or palette switch sets the tab in
  // the store first, which would unmount this tab before UnsavedChangesGuard could block it, so route the
  // switch first and let the URL-to-store sync commit it once the guard allows it.
  useLayoutEffect(() => {
    if (!dirty) return;
    const guard = (tab: Parameters<typeof adminTabToSlug>[0]) => {
      const location = router.state.location;
      const slug = adminTabToSlug(tab);
      if (slug === undefined) return false;
      if (location.pathname !== '/admin' || location.search.tab === slug) return true;
      void router.navigate({
        to: '/admin',
        search: previous => adminSearchForTab(previous, slug),
        replace: true,
      });
      return false;
    };
    useAdminModal.getState().setTabChangeGuard(guard);
    return () => {
      if (useAdminModal.getState().tabChangeGuard === guard) useAdminModal.getState().setTabChangeGuard(null);
    };
  }, [dirty, router]);

  // Drop the last bulk-action receipt when filters change
  useEffect(() => {
    setBulkNotice(null);
  }, [filterKey]);

  const touchModels = (modelIds: Iterable<string>) => {
    const now = new Date();
    setModelDates(prev => {
      const next = { ...prev };
      for (const id of modelIds) next[id] = { ...next[id], updatedAt: now };
      return next;
    });
  };

  const updateModel = (modelId: string, update: (model: LoadedModelConfiguration) => LoadedModelConfiguration) => {
    setLocalModels(prev => prev.map(model => (model.id === modelId ? update(model) : model)));
    touchModels([modelId]);
  };

  // "Select all matching" adds every row the filter shows, across pages, and keeps a selection made
  // under a different filter.
  const handleSelectAllMatching = () => {
    setSelectedModelIds(prev => [...new Set([...prev, ...filteredModels.map(model => model.id)])]);
  };

  const handleSelectionChange = (selection: AdminSelection) => {
    if (selection.mode === 'explicit') setSelectedModelIds([...selection.ids]);
  };

  // Writes through the same local state as the per-row switch, so the SaveBar persists a bulk
  // edit in one request.
  const handleBulkSetEnabled = (enabled: boolean) => {
    if (selectedFilteredIds.length === 0) return;
    const targetIds = new Set(selectedFilteredIds);
    setLocalModels(prev => prev.map(model => (targetIds.has(model.id) ? { ...model, enabled } : model)));
    touchModels(targetIds);
    // Under a status filter the changed rows leave the table on the spot, so say
    // how many moved before the operator concludes the click did nothing.
    const leavesFilter = filterStatus === (enabled ? 'disabled' : 'enabled');
    setBulkNotice(
      `${enabled ? 'Enabled' : 'Disabled'} ${targetIds.size} model${targetIds.size === 1 ? '' : 's'}.` +
        (leavesFilter ? ` ${targetIds.size} no longer match the current filter.` : '')
    );
  };

  const handleRankChange = (modelId: string, rankValue: string) => {
    // Parse rank value, treating empty string as undefined (no rank override)
    const rank = rankValue === '' ? undefined : parseInt(rankValue, 10);
    // Validate: only accept numbers 0-100 or undefined
    if (rank !== undefined && (isNaN(rank) || rank < 0 || rank > 100)) {
      return; // Invalid input, ignore
    }
    updateModel(modelId, model => ({ ...model, rank }));
  };

  const handleSave = async (reason: string) => {
    const changes = modelAccessChanges(localModels, saved.models);
    savingRef.current = { models: localModels, dates: modelDates };
    await saveLLMConfigurations.mutateAsync({ changes, reason, confirmAdminOnly });
    setSaveOpen(false);
  };

  const handleDiscard = () => {
    setLocalModels(saved.models);
    setModelDates(saved.dates);
    setBulkNotice(null);
  };

  const clearFilters = () => {
    resetSearchQuery('');
    setFilterType(undefined);
    setFilterBackend(undefined);
    setFilterStatus(undefined);
  };

  const getFallbackOptions = (currentModel: LLMModelConfig) => {
    return localModels.filter(
      model =>
        model.id !== currentModel.id &&
        model.enabled &&
        model.type === currentModel.type &&
        model.type !== 'speech-to-text'
    );
  };

  // Get all unique tags used across all models AND users
  const allUsedTags = useMemo(() => {
    const allTags = new Set<string>();
    // Add tags from model configurations
    localModels.forEach(model => {
      model.allowedUserTags.forEach(tag => allTags.add(tag.toLowerCase()));
    });

    // Add tags from user assignments
    usersData?.users?.forEach(user => {
      if (user.tags && user.tags.length > 0) {
        user.tags.forEach(tag => {
          if (!isOAuthSourceTag(tag)) allTags.add(tag.toLowerCase());
        });
      }
    });

    // Combine predefined tags with custom tags, maintaining order (predefined first)
    const predefinedValues = AVAILABLE_USER_TAGS.map(tag => tag.value.toLowerCase());
    const customTags = Array.from(allTags).filter(tag => !predefinedValues.includes(tag));

    return [...AVAILABLE_USER_TAGS, ...customTags.map(getTagInfo)];
  }, [localModels, usersData]);

  // Entitlement-key columns: registry-known keys plus any already configured on
  // a model (so a value set before it was added to the registry - or removed
  // from it - still renders and can be cleared rather than silently orphaned).
  const allEntitlementKeys = useMemo(() => {
    const keys = new Set<string>(KNOWN_ENTITLEMENT_KEYS);
    // normalizeEntitlementKey (trim + lowercase) matches the runtime access check,
    // so an out-of-band mixed-case/whitespace stored value collapses onto one column
    // instead of rendering a near-duplicate.
    localModels.forEach(model => model.allowedEntitlements?.forEach(key => keys.add(normalizeEntitlementKey(key))));
    return Array.from(keys).sort();
  }, [localModels]);

  const enabledModels = localModels.filter(m => m.enabled && m.type !== 'speech-to-text');
  const disabledModels = localModels.filter(m => !m.enabled && m.type !== 'speech-to-text');
  const textModels = localModels.filter(m => m.type === 'text' && m.enabled);
  const imageModels = localModels.filter(m => m.type === 'image' && m.enabled);

  const sized = (widthRem: number, column: Omit<DataColumn<LLMModelConfig>, 'width'>) => ({
    ...column,
    width: `${widthRem}rem`,
    widthRem,
  });

  const columns = [
    sized(14, { id: 'name', label: 'Model', render: model => model.name, sortValue: model => model.name }),
    sized(6, {
      id: 'type',
      label: 'Type',
      render: model => (model.type === 'text' ? 'Text' : 'Image'),
      sortValue: model => model.type,
    }),
    sized(9, { id: 'backend', label: 'Backend', render: model => model.backend, sortValue: model => model.backend }),
    sized(9, {
      id: 'status',
      label: 'Status',
      render: model => (
        <Stack direction="row" gap={1} alignItems="center">
          <Switch
            checked={model.enabled}
            onChange={() => updateModel(model.id, current => ({ ...current, enabled: !current.enabled }))}
            size="sm"
            slotProps={{ input: { 'aria-label': `Enable ${model.name}` } }}
            data-testid={`llm-dashboard-toggle-${model.id}`}
          />
          {model.enabled ? 'Enabled' : 'Disabled'}
        </Stack>
      ),
      sortValue: model => (model.enabled ? 'enabled' : 'disabled'),
    }),
    sized(7, {
      id: 'rank',
      label: 'Rank',
      render: model => (
        <Tooltip title="Lower rank = higher priority in model selection. Leave empty to use automatic ranking.">
          <Input
            type="number"
            placeholder="Auto"
            value={model.rank ?? ''}
            onChange={e => handleRankChange(model.id, e.target.value)}
            size="sm"
            slotProps={{ input: { min: 1, max: 100, step: 1, 'aria-label': `Rank for ${model.name}` } }}
            sx={{ width: '100%' }}
            data-testid={`llm-dashboard-rank-${model.id}`}
          />
        </Tooltip>
      ),
      // Models with a rank sort before models without one; lower rank = higher priority.
      sortValue: model => model.rank ?? Number.MAX_SAFE_INTEGER,
    }),
    sized(13, {
      id: 'fallback',
      label: 'Fallback model',
      render: model => (
        <Select
          placeholder="Select fallback model"
          value={model.fallbackModel || null}
          onChange={(_, value) => updateModel(model.id, current => ({ ...current, fallbackModel: value || '' }))}
          size="sm"
          sx={{ width: '100%' }}
          data-testid={`llm-dashboard-fallback-${model.id}`}
        >
          <Option value="">None</Option>
          {getFallbackOptions(model).map(fallbackModel => (
            <Option key={fallbackModel.id} value={fallbackModel.id}>
              {fallbackModel.name}
              {fallbackModel.backend === ModelBackend.Bedrock && (
                <Chip size="sm" variant="soft" color="neutral" sx={{ ml: 0.5 }}>
                  Bedrock
                </Chip>
              )}
            </Option>
          ))}
        </Select>
      ),
    }),
    sized(7.5, {
      id: 'createdAt',
      label: 'Created',
      render: model => formatDate(modelDates[model.id]?.createdAt),
      sortValue: model => modelDates[model.id]?.createdAt?.getTime() ?? 0,
    }),
    sized(7.5, {
      id: 'updatedAt',
      label: 'Updated',
      render: model => formatDate(modelDates[model.id]?.updatedAt),
      sortValue: model => modelDates[model.id]?.updatedAt?.getTime() ?? 0,
    }),
    ...allUsedTags.map(tag => {
      const label = `${tag.label} users`;
      return sized(accessColumnRem(label), {
        id: `tag-${tag.value}`,
        label,
        render: model => (
          <Checkbox
            checked={model.allowedUserTags.includes(tag.value)}
            onChange={e => {
              const checked = e.target.checked;
              updateModel(model.id, current => ({
                ...current,
                allowedUserTags: checked
                  ? [...current.allowedUserTags, tag.value]
                  : current.allowedUserTags.filter(t => t !== tag.value),
              }));
            }}
            size="sm"
            aria-label={`${tag.label} users can access ${model.name}`}
            data-testid={`llm-dashboard-tag-${model.id}-${tag.value}`}
          />
        ),
      });
    }),
    ...allEntitlementKeys.map(key =>
      sized(accessColumnRem(key), {
        id: `entitlement-${key}`,
        label: key,
        render: model => (
          // Compare/write on the normalized form so a stored mixed-case or
          // whitespace-padded value matches its (canonical) column key -
          // toggling never leaves a near-duplicate behind.
          <Checkbox
            checked={(model.allowedEntitlements ?? []).some(k => normalizeEntitlementKey(k) === key)}
            onChange={e => {
              const checked = e.target.checked;
              updateModel(model.id, current => {
                const withoutKey = (current.allowedEntitlements ?? []).filter(k => normalizeEntitlementKey(k) !== key);
                return { ...current, allowedEntitlements: checked ? [...withoutKey, key] : withoutKey };
              });
            }}
            size="sm"
            aria-label={`Users entitled to "${key}" can access ${model.name}`}
            data-testid={`llm-dashboard-entitlement-${model.id}-${key}`}
          />
        ),
      })
    ),
  ];
  const tableMinWidth = `${columns.reduce((sum, column) => sum + column.widthRem, SELECTION_COLUMN_REM)}rem`;

  const header = (
    <AdminPageHeader
      title="Models"
      description="Turn models on or off and choose which user tags and entitlements can use each one."
      actions={<ContextHelpButton helpId="admin/llm-dashboard" tooltipText="Models help" />}
    />
  );
  const rootSx = { gap: ADMIN_REGION_GAP, minWidth: 0 };

  if (isLoading) {
    return (
      <Stack sx={rootSx} data-testid="llm-dashboard-root">
        {header}
        <LoadingState label="Loading models" testId="llm-dashboard-loading" />
      </Stack>
    );
  }

  // A failed background refetch keeps the loaded models (and any unsaved edits) on screen.
  if (error && (!modelInfos || (configError && !initialized))) {
    return (
      <Stack sx={rootSx} data-testid="llm-dashboard-root">
        {header}
        <ErrorState
          message={`Could not load models: ${error.message}`}
          onRetry={() => {
            void refetchModelInfo();
            void refetchConfigurations();
          }}
        />
      </Stack>
    );
  }

  return (
    <Stack sx={rootSx} data-testid="llm-dashboard-root">
      {header}

      {error && initialized && (
        <ErrorState
          message="Could not refresh models. The loaded editor and unsaved changes are retained."
          onRetry={() => {
            void refetchModelInfo();
            void refetchConfigurations();
          }}
        />
      )}

      <Alert color="neutral" data-testid="llm-dashboard-access-banner">
        <span>
          <strong>Model access control:</strong> When a model is disabled, all users lose access. The user tag and
          entitlement columns control which users can access an enabled model.
        </span>
      </Alert>

      <StatStrip aria-label="Model counts">
        <StatTile label="Enabled" value={enabledModels.length} />
        <StatTile label="Disabled" value={disabledModels.length} />
        <StatTile label="Text models" value={textModels.length} />
        <StatTile label="Image models" value={imageModels.length} />
      </StatStrip>

      <Stack
        direction="row"
        flexWrap="wrap"
        alignItems="center"
        gap={1}
        sx={adminFocusScope}
        data-testid="llm-dashboard-filters"
      >
        <AdminSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          label="Search models"
          data-testid="llm-dashboard-search-input"
        />
        <FilterChip id="type" label="Type" value={filterType} options={TYPE_OPTIONS} onChange={setFilterType} />
        <FilterChip
          id="backend"
          label="Backend"
          value={filterBackend}
          options={BACKEND_OPTIONS}
          onChange={setFilterBackend}
        />
        <FilterChip
          id="status"
          label="Status"
          value={filterStatus}
          options={STATUS_OPTIONS}
          onChange={setFilterStatus}
        />
      </Stack>

      {bulkNotice && (
        <Alert color="neutral" data-testid="llm-dashboard-bulk-notice">
          {bulkNotice}
        </Alert>
      )}

      <DataTable
        label="Models"
        testId="llm-dashboard-table"
        rows={filteredModels}
        columns={columns}
        getRowId={model => model.id}
        rowTestId={model => `llm-dashboard-row-${model.id}`}
        selection={{ mode: 'explicit', ids: selectedModelIds }}
        onSelectionChange={handleSelectionChange}
        pageResetKey={filterKey}
        minWidth={tableMinWidth}
        alwaysShowScrollbar
        onRetry={() => {
          void refetchModelInfo();
          void refetchConfigurations();
        }}
        empty={
          hasFilters ? (
            <EmptyState
              title="No models match these filters"
              action={
                <Button variant="outlined" onClick={clearFilters} data-testid="llm-dashboard-clear-filters-btn">
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No models available"
              description="Models appear here once the model catalog lists them."
              action={
                <Button
                  variant="outlined"
                  onClick={() => void refetchModelInfo()}
                  data-testid="llm-dashboard-refresh-btn"
                >
                  Refresh models
                </Button>
              }
            />
          )
        }
      />

      {(selectedModelIds.length > 0 || changedCount > 0) && (
        // One sticky dock, so the bulk bar and the save bar stack instead of overlapping. Left-aligned so
        // the AI chat pill in the bottom-right corner does not cover their buttons (as UsersBulkBar does).
        // The dock spans the content width, so it must not take clicks meant for the rows beside the bars.
        <Stack
          gap={1}
          alignItems="flex-start"
          sx={{ position: 'sticky', bottom: 8, zIndex: 3, pointerEvents: 'none' }}
          data-testid="llm-dashboard-dock"
        >
          {selectedModelIds.length > 0 && (
            <Box data-testid="llm-dashboard-bulk-bar" sx={{ maxWidth: '100%', pointerEvents: 'auto' }}>
              <BulkActionBar
                selection={{ mode: 'explicit', ids: selectedModelIds }}
                totalMatching={filteredModels.length}
                onSelectAllMatching={handleSelectAllMatching}
                onClear={() => setSelectedModelIds([])}
              >
                {hiddenSelectedCount > 0 && (
                  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="llm-dashboard-bulk-count">
                    {`${selectedFilteredIds.length} of ${selectedModelIds.length} selected models match this filter`}
                  </Typography>
                )}
                <Button
                  size="sm"
                  variant="outlined"
                  disabled={selectedFilteredIds.length === 0}
                  onClick={() => handleBulkSetEnabled(true)}
                  data-testid="llm-dashboard-bulk-enable-btn"
                >
                  Enable selected
                </Button>
                <Button
                  size="sm"
                  variant="outlined"
                  disabled={selectedFilteredIds.length === 0}
                  onClick={() => handleBulkSetEnabled(false)}
                  data-testid="llm-dashboard-bulk-disable-btn"
                >
                  Disable selected
                </Button>
              </BulkActionBar>
            </Box>
          )}
          <Box data-testid="llm-dashboard-save-bar-dock" sx={{ maxWidth: '100%', pointerEvents: 'auto' }}>
            <SaveBar
              count={changedCount}
              pending={saveLLMConfigurations.isPending}
              onSave={() => {
                setConfirmAdminOnly(false);
                setSaveOpen(true);
              }}
              onDiscard={handleDiscard}
            />
          </Box>
        </Stack>
      )}

      <ActionDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save model access"
        description="Save the changed models against the versions loaded in this editor. A conflicting edit requires a reload."
        reasonPresets={['Update model availability', 'Adjust model access', 'Change model routing']}
        confirmLabel="Save changes"
        onConfirm={handleSave}
        pending={saveLLMConfigurations.isPending}
        data-testid="llm-dashboard-save-dialog"
      >
        <Checkbox
          checked={confirmAdminOnly}
          onChange={event => setConfirmAdminOnly(event.target.checked)}
          disabled={saveLLMConfigurations.isPending}
          label="Confirm any changed models restricted to administrators only"
        />
      </ActionDialog>
      <UnsavedChangesGuard dirty={dirty} pending={saveLLMConfigurations.isPending} isLeaving={isLeavingTab} />
    </Stack>
  );
};

export default LLMDashboardTab;
