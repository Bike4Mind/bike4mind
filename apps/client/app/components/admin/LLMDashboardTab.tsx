import React, { useState, useMemo, useEffect } from 'react';
import {
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  Select,
  Option,
  Sheet,
  Stack,
  Switch,
  Table,
  Typography,
  Alert,
  Checkbox,
  Tooltip,
  Box,
  Input,
  useTheme,
} from '@mui/joy';
import {
  Image as ImageIcon,
  Chat as ChatIcon,
  Security as SecurityIcon,
  Save as SaveIcon,
  ArrowUpward as ArrowUpwardIcon,
  ArrowDownward as ArrowDownwardIcon,
  UnfoldMore as UnfoldMoreIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  FirstPage as FirstPageIcon,
  LastPage as LastPageIcon,
} from '@mui/icons-material';
import { LLMModelConfig, ModelBackend, normalizeEntitlementKey } from '@bike4mind/common';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import {
  useLLMModelConfigurationsWithDefaults,
  useSaveLLMModelConfigurations,
} from '@client/app/hooks/data/llmModelConfig';
import { useGetUsers } from '@client/app/hooks/data/user';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { KNOWN_ENTITLEMENT_KEYS } from '@client/lib/entitlements/registry';

// Available user tags for permissions (used in table display)
// 'admin' access is handled via user.isAdmin property, not tags
const AVAILABLE_USER_TAGS = [
  { value: 'developer', label: 'Developer', color: 'warning' as const },
  { value: 'customer', label: 'Customer', color: 'danger' as const },
];

// Color rotation for custom tags
const ALTERNATIVE_COLORS = ['success', 'primary', 'danger', 'warning'] as const;

// Utility function to get tag info for both predefined and custom tags
const getTagInfo = (tagValue: string, index: number = 0) => {
  const predefinedTag = AVAILABLE_USER_TAGS.find(tag => tag.value === tagValue);
  if (predefinedTag) {
    return predefinedTag;
  }

  // Alternate colors for custom tags based on index
  const colorIndex = index % ALTERNATIVE_COLORS.length;

  return {
    value: tagValue,
    label: tagValue.charAt(0).toUpperCase() + tagValue.slice(1),
    color: ALTERNATIVE_COLORS[colorIndex],
  };
};

const LLMDashboardTab: React.FC = () => {
  const { data: modelInfos, isLoading: modelInfoLoading, error } = useModelInfo();
  const { data: models, isLoading: configLoading } = useLLMModelConfigurationsWithDefaults(modelInfos);
  const { data: usersData, isLoading: usersLoading } = useGetUsers({
    page: 1,
    limit: 1000, // Get all users to extract their tags
  });
  const [localModels, setLocalModels] = useState<LLMModelConfig[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'text' | 'image'>('all');
  const [filterBackend, setFilterBackend] = useState<string>('all');
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [sortColumn, setSortColumn] = useState<
    'name' | 'type' | 'backend' | 'status' | 'rank' | 'createdAt' | 'updatedAt' | null
  >(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [modelDates, setModelDates] = useState<Record<string, { createdAt?: Date; updatedAt?: Date }>>({});
  const theme = useTheme();

  const saveLLMConfigurations = useSaveLLMModelConfigurations(() => {
    setHasUnsavedChanges(false);
    // Keep the local state to avoid flickering, don't reinitialize
  });

  // Initialize local models when configurations are loaded
  useEffect(() => {
    if (models && models.length > 0 && !initialized) {
      setLocalModels(models);
      setInitialized(true);
      setHasUnsavedChanges(false);

      // Initialize dates for models (using current date as placeholder)
      // In a real implementation, these would come from the backend
      const initialDates: Record<string, { createdAt?: Date; updatedAt?: Date }> = {};
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
      setModelDates(initialDates);
    }
  }, [models, initialized]);

  const isLoading = modelInfoLoading || configLoading || usersLoading;

  const handleSort = (column: 'name' | 'type' | 'backend' | 'status' | 'rank' | 'createdAt' | 'updatedAt') => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const filteredModels = useMemo(() => {
    const filtered = localModels.filter(model => {
      if (filterType !== 'all' && model.type !== filterType) return false;
      if (filterBackend !== 'all' && model.backend !== filterBackend) return false;
      if (filterEnabled === 'enabled' && !model.enabled) return false;
      if (filterEnabled === 'disabled' && model.enabled) return false;
      if (model.type === 'speech-to-text') return false;
      return true;
    });

    if (sortColumn) {
      filtered.sort((a, b) => {
        let aValue: string | Date | number;
        let bValue: string | Date | number;

        switch (sortColumn) {
          case 'name':
            aValue = a.name;
            bValue = b.name;
            break;
          case 'type':
            aValue = a.type;
            bValue = b.type;
            break;
          case 'backend':
            aValue = a.backend;
            bValue = b.backend;
            break;
          case 'status':
            aValue = a.enabled ? 'enabled' : 'disabled';
            bValue = b.enabled ? 'enabled' : 'disabled';
            break;
          case 'rank':
            // Models with rank set should be sorted before models without rank
            // Lower rank = higher priority
            aValue = a.rank ?? Number.MAX_SAFE_INTEGER;
            bValue = b.rank ?? Number.MAX_SAFE_INTEGER;
            break;
          case 'createdAt':
            aValue = modelDates[a.id]?.createdAt || new Date(0);
            bValue = modelDates[b.id]?.createdAt || new Date(0);
            break;
          case 'updatedAt':
            aValue = modelDates[a.id]?.updatedAt || new Date(0);
            bValue = modelDates[b.id]?.updatedAt || new Date(0);
            break;
          default:
            return 0;
        }

        let comparison: number;
        if (aValue instanceof Date && bValue instanceof Date) {
          comparison = aValue.getTime() - bValue.getTime();
        } else if (typeof aValue === 'number' && typeof bValue === 'number') {
          comparison = aValue - bValue;
        } else if (typeof aValue === 'string' && typeof bValue === 'string') {
          comparison = aValue.localeCompare(bValue);
        } else {
          comparison = 0;
        }

        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }

    return filtered;
  }, [localModels, filterType, filterBackend, filterEnabled, sortColumn, sortDirection, modelDates]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredModels.length / rowsPerPage);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;
  const paginatedModels = filteredModels.slice(startIndex, endIndex);

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [filterType, filterBackend, filterEnabled]);

  const handlePageChange = (page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  };

  const handleRowsPerPageChange = (value: number) => {
    setRowsPerPage(value);
    setCurrentPage(1);
  };

  const handleToggleModel = (modelId: string) => {
    setLocalModels(prev => prev.map(model => (model.id === modelId ? { ...model, enabled: !model.enabled } : model)));
    setHasUnsavedChanges(true);
    // Update the updatedAt timestamp
    setModelDates(prev => ({
      ...prev,
      [modelId]: {
        ...prev[modelId],
        updatedAt: new Date(),
      },
    }));
  };

  const handleFallbackModelChange = (modelId: string, fallbackModel: string) => {
    setLocalModels(prev => prev.map(model => (model.id === modelId ? { ...model, fallbackModel } : model)));
    setHasUnsavedChanges(true);
    // Update the updatedAt timestamp
    setModelDates(prev => ({
      ...prev,
      [modelId]: {
        ...prev[modelId],
        updatedAt: new Date(),
      },
    }));
  };

  const handleRankChange = (modelId: string, rankValue: string) => {
    // Parse rank value, treating empty string as undefined (no rank override)
    const rank = rankValue === '' ? undefined : parseInt(rankValue, 10);
    // Validate: only accept numbers 0-100 or undefined
    if (rank !== undefined && (isNaN(rank) || rank < 0 || rank > 100)) {
      return; // Invalid input, ignore
    }
    setLocalModels(prev => prev.map(model => (model.id === modelId ? { ...model, rank } : model)));
    setHasUnsavedChanges(true);
    // Update the updatedAt timestamp
    setModelDates(prev => ({
      ...prev,
      [modelId]: {
        ...prev[modelId],
        updatedAt: new Date(),
      },
    }));
  };

  const handleUserTagsChange = (modelId: string, newTags: string[]) => {
    setLocalModels(prev => prev.map(model => (model.id === modelId ? { ...model, allowedUserTags: newTags } : model)));
    setHasUnsavedChanges(true);
    // Update the updatedAt timestamp
    setModelDates(prev => ({
      ...prev,
      [modelId]: {
        ...prev[modelId],
        updatedAt: new Date(),
      },
    }));
  };

  const handleEntitlementsChange = (modelId: string, newEntitlements: string[]) => {
    setLocalModels(prev =>
      prev.map(model => (model.id === modelId ? { ...model, allowedEntitlements: newEntitlements } : model))
    );
    setHasUnsavedChanges(true);
    setModelDates(prev => ({
      ...prev,
      [modelId]: {
        ...prev[modelId],
        updatedAt: new Date(),
      },
    }));
  };

  const handleSaveConfigurations = () => {
    saveLLMConfigurations.mutate(localModels);
  };

  const getBackendColor = (backend: ModelBackend) => {
    switch (backend) {
      case ModelBackend.OpenAI:
        return 'success';
      case ModelBackend.Anthropic:
        return 'warning';
      case ModelBackend.Gemini:
        return 'primary';
      case ModelBackend.BFL:
        return 'danger';
      default:
        return 'neutral';
    }
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
    localModels.forEach((model, index) => {
      model.allowedUserTags.forEach(tag => allTags.add(tag.toLowerCase()));
    });

    // Add tags from user assignments
    usersData?.users?.forEach((user, index) => {
      if (user.tags && user.tags.length > 0) {
        user.tags.forEach(tag => allTags.add(tag.toLowerCase()));
      }
    });

    // Combine predefined tags with custom tags, maintaining order (predefined first)
    const predefinedValues = AVAILABLE_USER_TAGS.map(tag => tag.value.toLowerCase());
    const customTags = Array.from(allTags).filter(tag => !predefinedValues.includes(tag));

    return [...AVAILABLE_USER_TAGS, ...customTags.map((tag, index) => getTagInfo(tag, index))];
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

  if (isLoading) {
    return (
      <Sheet sx={{ p: 2, width: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="center" alignItems="center" sx={{ height: '400px' }}>
          <Typography level="h4">Loading models...</Typography>
        </Stack>
      </Sheet>
    );
  }

  if (error) {
    return (
      <Sheet sx={{ p: 2, width: '100%', overflow: 'auto' }}>
        <Alert variant="soft" color="danger" sx={{ mb: 3 }}>
          <Typography level="body-sm">
            <strong>Error loading models:</strong> {error.message}
          </Typography>
        </Alert>
      </Sheet>
    );
  }

  return (
    <Sheet sx={{ p: 2, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ flexShrink: 0 }}>
        <Alert variant="soft" color="primary" sx={{ mb: 3 }} startDecorator={<SecurityIcon />}>
          <Typography level="body-sm">
            <strong>Model Access Control:</strong> When a model is disabled, all users lose access. User tag permissions
            control which user groups can access enabled models.
          </Typography>
        </Alert>

        {hasUnsavedChanges && (
          <Alert variant="soft" color="warning" sx={{ mb: 3 }}>
            <Typography level="body-sm">
              <strong>Unsaved Changes:</strong> You have unsaved changes. Click &quot;Save Changes&quot; to persist your
              configuration.
            </Typography>
          </Alert>
        )}

        {/* Statistics Cards */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid xs={12} sm={6} md={3}>
            <Card variant="soft" color="success">
              <CardContent>
                <Typography level="body-sm">Enabled Models</Typography>
                <Typography level="h2">{enabledModels.length}</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={12} sm={6} md={3}>
            <Card variant="soft" color="neutral">
              <CardContent>
                <Typography level="body-sm">Disabled Models</Typography>
                <Typography level="h2">{disabledModels.length}</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={12} sm={6} md={3}>
            <Card variant="soft" color="primary">
              <CardContent>
                <Typography level="body-sm">Text Models</Typography>
                <Typography level="h2">{textModels.length}</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid xs={12} sm={6} md={3}>
            <Card variant="soft" color="warning">
              <CardContent>
                <Typography level="body-sm">Image Models</Typography>
                <Typography level="h2">{imageModels.length}</Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Filters */}
        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'stretch', lg: 'center' }}
          spacing={2}
          sx={{ mb: 3 }}
        >
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'center' }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="title-sm" sx={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>
                Type:
              </Typography>
              <Select
                size="sm"
                value={filterType}
                onChange={(_, value) => setFilterType(value as 'all' | 'text' | 'image')}
                sx={{ minWidth: 120 }}
              >
                <Option value="all">All Types</Option>
                <Option value="text">Text Models</Option>
                <Option value="image">Image Models</Option>
              </Select>
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="title-sm" sx={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>
                Backend:
              </Typography>
              <Select
                size="sm"
                value={filterBackend}
                onChange={(_, value) => setFilterBackend(value as string)}
                sx={{ minWidth: 120 }}
              >
                <Option value="all">All Backends</Option>
                {Object.values(ModelBackend).map(backend => (
                  <Option key={backend} value={backend}>
                    {backend}
                  </Option>
                ))}
              </Select>
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="title-sm" sx={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>
                Status:
              </Typography>
              <Select
                size="sm"
                value={filterEnabled}
                onChange={(_, value) => setFilterEnabled(value as 'all' | 'enabled' | 'disabled')}
                sx={{ minWidth: 120 }}
              >
                <Option value="all">All Models</Option>
                <Option value="enabled">Enabled Only</Option>
                <Option value="disabled">Disabled Only</Option>
              </Select>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              startDecorator={<SaveIcon />}
              variant="solid"
              color={hasUnsavedChanges ? 'primary' : 'success'}
              disabled={!hasUnsavedChanges || saveLLMConfigurations.isPending}
              onClick={handleSaveConfigurations}
              loading={saveLLMConfigurations.isPending}
              sx={{ width: { xs: '100%', lg: 'auto' } }}
            >
              {hasUnsavedChanges ? 'Save Changes' : 'Saved'}
            </Button>
            <ContextHelpButton helpId="admin/llm-dashboard" tooltipText="LLM Dashboard Help" />
          </Stack>
        </Stack>
      </Box>

      {/* Models Table */}
      <Sheet sx={{ flex: 1, minHeight: 0, overflow: 'auto', overflowX: { xs: 'auto', sm: 'visible' } }}>
        <Table aria-label="LLM Models table" stickyHeader hoverRow sx={{ minWidth: { xs: '800px', sm: 'auto' } }}>
          <thead style={{ backgroundColor: theme.palette.background.level1 }}>
            {/* Headers */}
            <tr>
              <th
                style={{
                  width: '15%',
                  verticalAlign: 'top',
                  cursor: 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                }}
                onClick={() => handleSort('name')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center">
                  Model
                  {sortColumn === 'name' ? (
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
                style={{
                  width: '7.5%',
                  verticalAlign: 'top',
                  cursor: 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                }}
                onClick={() => handleSort('type')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center">
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
              <th
                style={{
                  width: '7.5%',
                  verticalAlign: 'top',
                  cursor: 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                }}
                onClick={() => handleSort('backend')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center">
                  Backend
                  {sortColumn === 'backend' ? (
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
                style={{
                  width: '7.5%',
                  verticalAlign: 'top',
                  cursor: 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                }}
                onClick={() => handleSort('status')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center">
                  Status
                  {sortColumn === 'status' ? (
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
                style={{
                  width: '5%',
                  verticalAlign: 'top',
                  cursor: 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                }}
                onClick={() => handleSort('rank')}
              >
                <Tooltip title="Lower rank = higher priority in model selection. Leave empty to use automatic ranking.">
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    Rank
                    {sortColumn === 'rank' ? (
                      sortDirection === 'asc' ? (
                        <ArrowUpwardIcon fontSize="small" />
                      ) : (
                        <ArrowDownwardIcon fontSize="small" />
                      )
                    ) : (
                      <UnfoldMoreIcon fontSize="small" />
                    )}
                  </Stack>
                </Tooltip>
              </th>
              <th
                style={{
                  width: '12%',
                  verticalAlign: 'top',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                }}
              >
                Fallback Model
              </th>
              <th
                style={{
                  width: '10%',
                  verticalAlign: 'top',
                  cursor: 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                }}
                onClick={() => handleSort('createdAt')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center">
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
                style={{
                  width: '10%',
                  verticalAlign: 'top',
                  cursor: 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                }}
                onClick={() => handleSort('updatedAt')}
              >
                <Stack direction="row" spacing={0.5} alignItems="center">
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
              <th
                style={{
                  verticalAlign: 'top',
                  width: 'auto',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                  paddingLeft: '8px',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    paddingLeft: '12px',
                  }}
                >
                  <Typography sx={{ textAlign: 'center', marginBottom: 1, width: 'fit-content' }}>
                    Users Allowed
                  </Typography>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      flexDirection: 'row',
                      gap: 0.3,
                      justifyContent: 'flex-start',
                    }}
                  >
                    {allUsedTags.map(tag => (
                      <Box
                        key={tag.value}
                        sx={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          minWidth: '60px',
                          textAlign: 'center',
                        }}
                      >
                        <Typography
                          level="title-sm"
                          sx={{
                            textAlign: 'center',
                            padding: '1px 2px',
                            fontSize: '9px',
                            lineHeight: 1.1,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            width: '100%',
                          }}
                        >
                          {tag.label}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </Box>
              </th>
              <th
                style={{
                  verticalAlign: 'top',
                  width: 'auto',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1001,
                  paddingLeft: '8px',
                }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', paddingLeft: '12px' }}>
                  <Typography sx={{ textAlign: 'center', marginBottom: 1, width: 'fit-content' }}>
                    Entitlements Allowed
                  </Typography>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      flexDirection: 'row',
                      gap: 0.3,
                      justifyContent: 'flex-start',
                    }}
                  >
                    {allEntitlementKeys.length === 0 ? (
                      <Typography level="body-xs" sx={{ fontStyle: 'italic', opacity: 0.6, whiteSpace: 'nowrap' }}>
                        none configured
                      </Typography>
                    ) : (
                      allEntitlementKeys.map(key => (
                        <Box
                          key={key}
                          sx={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            minWidth: '60px',
                            textAlign: 'center',
                          }}
                        >
                          <Typography
                            level="title-sm"
                            sx={{
                              textAlign: 'center',
                              padding: '1px 2px',
                              fontSize: '9px',
                              lineHeight: 1.1,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              width: '100%',
                            }}
                          >
                            {key}
                          </Typography>
                        </Box>
                      ))
                    )}
                  </Box>
                </Box>
              </th>
            </tr>
          </thead>
          <tbody>
            {paginatedModels.map(model => (
              <tr key={model.id}>
                <td>
                  <Typography level="body-sm" fontWeight="md">
                    {model.name}
                  </Typography>
                </td>
                <td>
                  <Chip
                    variant="soft"
                    color={model.type === 'text' ? 'primary' : 'warning'}
                    startDecorator={model.type === 'text' ? <ChatIcon /> : <ImageIcon />}
                  >
                    {model.type === 'text' ? 'Text' : 'Image'}
                  </Chip>
                </td>
                <td>
                  <Chip variant="soft" color={getBackendColor(model.backend)}>
                    {model.backend}
                  </Chip>
                </td>
                <td>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Switch
                      checked={model.enabled}
                      onChange={() => handleToggleModel(model.id)}
                      color={model.enabled ? 'success' : 'neutral'}
                      size="sm"
                    />
                    <Typography level="body-xs" color={model.enabled ? 'success' : 'neutral'}>
                      {model.enabled ? 'Enabled' : 'Disabled'}
                    </Typography>
                  </Stack>
                </td>
                <td>
                  <Input
                    type="number"
                    placeholder="Auto"
                    value={model.rank ?? ''}
                    onChange={e => handleRankChange(model.id, e.target.value)}
                    size="sm"
                    slotProps={{
                      input: {
                        min: 1,
                        max: 100,
                        step: 1,
                      },
                    }}
                    sx={{ width: '70px' }}
                  />
                </td>
                <td>
                  <Select
                    placeholder="Select fallback model"
                    value={model.fallbackModel || null}
                    onChange={(_, value) => handleFallbackModelChange(model.id, value || '')}
                    size="sm"
                    sx={{ width: '90%' }}
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
                </td>
                <td>
                  <Typography level="body-xs">
                    {modelDates[model.id]?.createdAt
                      ? new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        }).format(modelDates[model.id].createdAt)
                      : '-'}
                  </Typography>
                </td>
                <td>
                  <Typography level="body-xs">
                    {modelDates[model.id]?.updatedAt
                      ? new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        }).format(modelDates[model.id].updatedAt)
                      : '-'}
                  </Typography>
                </td>
                <td style={{ paddingLeft: '8px' }}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      flexDirection: 'row',
                      gap: 0.3,
                      justifyContent: 'flex-start',
                      paddingLeft: '12px',
                    }}
                  >
                    {allUsedTags.map(tag => (
                      <Box key={tag.value} sx={{ display: 'flex', justifyContent: 'center', minWidth: '60px' }}>
                        <Tooltip title={`${tag.label} users can access this model`}>
                          <Checkbox
                            checked={model.allowedUserTags.includes(tag.value)}
                            onChange={e => {
                              const newTags = e.target.checked
                                ? [...model.allowedUserTags, tag.value]
                                : model.allowedUserTags.filter(t => t !== tag.value);

                              handleUserTagsChange(model.id, newTags);
                            }}
                            color={tag.color}
                            size="sm"
                            sx={{
                              '& .MuiCheckbox-checkbox': { fontSize: '14px' },
                            }}
                          />
                        </Tooltip>
                      </Box>
                    ))}
                  </Box>
                </td>
                <td style={{ paddingLeft: '8px' }}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      flexDirection: 'row',
                      gap: 0.3,
                      justifyContent: 'flex-start',
                      paddingLeft: '12px',
                    }}
                  >
                    {allEntitlementKeys.map(key => {
                      const current = model.allowedEntitlements ?? [];
                      // Compare/write on the normalized form so a stored mixed-case or
                      // whitespace-padded value matches its (canonical) column key -
                      // toggling never leaves a near-duplicate behind.
                      return (
                        <Box key={key} sx={{ display: 'flex', justifyContent: 'center', minWidth: '60px' }}>
                          <Tooltip title={`Users entitled to "${key}" can access this model`}>
                            <Checkbox
                              checked={current.some(k => normalizeEntitlementKey(k) === key)}
                              onChange={e => {
                                const withoutKey = current.filter(k => normalizeEntitlementKey(k) !== key);
                                const newEntitlements = e.target.checked ? [...withoutKey, key] : withoutKey;

                                handleEntitlementsChange(model.id, newEntitlements);
                              }}
                              color="success"
                              size="sm"
                              sx={{
                                '& .MuiCheckbox-checkbox': { fontSize: '14px' },
                              }}
                            />
                          </Tooltip>
                        </Box>
                      );
                    })}
                  </Box>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Sheet>

      {/* Pagination Controls */}
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        justifyContent="space-between"
        sx={{ mt: 2, px: 1, flexShrink: 0 }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
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
          <Typography level="body-sm" sx={{ ml: 2 }}>
            {startIndex + 1}-{Math.min(endIndex, filteredModels.length)} of {filteredModels.length} models
          </Typography>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => handlePageChange(1)}
            disabled={currentPage === 1}
            startDecorator={<FirstPageIcon />}
          >
            First
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1}
            startDecorator={<ChevronLeftIcon />}
          >
            Previous
          </Button>
          <Typography level="body-sm" sx={{ px: 2 }}>
            Page {currentPage} of {totalPages || 1}
          </Typography>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage === totalPages || totalPages === 0}
            endDecorator={<ChevronRightIcon />}
          >
            Next
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => handlePageChange(totalPages)}
            disabled={currentPage === totalPages || totalPages === 0}
            endDecorator={<LastPageIcon />}
          >
            Last
          </Button>
        </Stack>
      </Stack>
    </Sheet>
  );
};

export default LLMDashboardTab;
