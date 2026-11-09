import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  DialogContent,
  Dropdown,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  Option,
  Select,
  Stack,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { useQuery } from '@tanstack/react-query';
import { useExperimentalFeatureSettings, useUpdateSettings } from '@client/app/hooks/data/settings';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import {
  ModelInfo,
  RapidReplyFallbackBehaviors,
  RapidReplyResponseStylesCommon,
  RapidReplyTransitionModes,
  type RapidReplySettings,
} from '@bike4mind/common';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { IRapidReplyMapping } from '@bike4mind/common/types/entities/RapidReplyTypes';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { RapidReplyMetrics, type RapidReplyMetricsData } from './RapidReplyMetrics';
import { RapidReplyTestPanel } from './RapidReplyTestPanel';
import { useSaveMapping, useDeleteMapping } from '@client/app/hooks/data/rapidReplyMutations';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { SettingsDraftProvider, useSettingsDraft } from './SettingsDraftProvider';
import {
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  SettingsSection,
  StatusChip,
  type DataColumn,
} from './shared';
import { ADMIN_DETAIL_MAX_WIDTH, ADMIN_REGION_GAP, adminFocus, adminTabStrip } from './shared/adminStyles';

const defaultPrompt = `IMPORTANT: DO NOT ANSWER THE QUESTION. You are providing a quick, friendly acknowledgment that shows you understand the topic while the full response is being prepared. Keep it to ONE sentence only and reference the subject matter.

        Examples:
        - For coding questions: "Working through that [language/framework] code now!"
        - For research requests: "Gathering the latest on [topic] for you!"
        - For creative tasks: "Love this [writing/design] idea - crafting it now!"
        - For technical issues: "Analyzing that [specific problem] - solution coming up!"

        Single sentence only. Always acknowledge the specific topic while indicating work is in progress.`;

const EMPTY_MAPPING: Partial<IRapidReplyMapping> = {
  mainModelId: '',
  rapidModelId: '',
  enabled: true,
  priority: 1,
  systemPrompt: defaultPrompt,
  maxTokens: 100,
  responseStyle: 'auto',
  maxLatency: 1500,
};

const RAPID_MODEL_NAME_HINTS = ['mini', 'nano', 'haiku', 'flash', 'small', 'fast'];

const LATENCY_RANGE = { min: 500, max: 5000 };
const SUCCESS_RATE_RANGE = { min: 0, max: 100 };

type RapidReplyTabKey = 'models' | 'metrics' | 'test';

interface MappingsResponse {
  mappings: IRapidReplyMapping[];
  /**
   * Computed server-side against the same getAvailableModels call the rapid-reply endpoint makes, rather
   * than re-derived from useModelInfo here: that list comes from the picker route, which excludes private
   * models and would report false rot for one.
   */
  unavailableRapidModelIds?: string[];
}

/** The four RapidReplySettings fields this page owns; a save writes exactly these, as it always has. */
type RapidReplyPageSettings = Pick<
  RapidReplySettings,
  'transitionMode' | 'fallbackBehavior' | 'maxAcceptableLatency' | 'minSuccessRate'
>;

const useRapidReplyMappings = () =>
  useQuery({
    queryKey: ['rapid-reply-mappings'],
    queryFn: async (): Promise<MappingsResponse> => {
      const response = await api.get('/api/admin/rapid-reply/mappings');
      return response.data;
    },
  });

const useRapidReplyMetrics = () =>
  useQuery({
    queryKey: ['rapid-reply-metrics'],
    queryFn: async (): Promise<RapidReplyMetricsData | null> => {
      const response = await api.get('/api/admin/rapid-reply/metrics');
      return response.data;
    },
    refetchInterval: 30_000,
  });

const readPageSettings = (stored: unknown): RapidReplyPageSettings => {
  const value = (stored ?? {}) as Partial<RapidReplyPageSettings>;
  return {
    transitionMode: value.transitionMode || 'replace',
    fallbackBehavior: value.fallbackBehavior || 'continue',
    maxAcceptableLatency: value.maxAcceptableLatency || 2000,
    minSuccessRate: value.minSuccessRate || 90,
  };
};

const outOfRange = (value: number, range: { min: number; max: number }, unit: string) =>
  Number.isFinite(value) && value >= range.min && value <= range.max
    ? undefined
    : `Enter ${range.min} to ${range.max}${unit}`;

const parseNumberInput = (raw: string) => (raw === '' ? Number.NaN : Number(raw));

const MappingDialog: React.FC<{
  onClose: () => void;
  mapping?: IRapidReplyMapping;
  availableModels: ModelInfo[];
  metrics?: RapidReplyMetricsData | null;
  maxLatencyThreshold: number;
}> = ({ onClose, mapping, availableModels, metrics, maxLatencyThreshold }) => {
  const saveMapping = useSaveMapping();
  const [formData, setFormData] = useState<Partial<IRapidReplyMapping>>(mapping ?? EMPTY_MAPPING);

  const rapidModels = availableModels.filter(model =>
    RAPID_MODEL_NAME_HINTS.some(hint => model.name.toLowerCase().includes(hint))
  );

  const modelLatency = (modelId: string) =>
    metrics?.modelBreakdown?.find(entry => entry.rapidModel === modelId)?.avgLatency || null;

  const blockedReason = !formData.mainModelId
    ? 'Pick a main model.'
    : !formData.rapidModelId
      ? 'Pick a rapid model.'
      : undefined;

  const handleSave = async () => {
    try {
      await saveMapping.mutateAsync(formData);
      onClose();
    } catch {
      // Rendered from saveMapping.error below.
    }
  };

  return (
    <AdminDialog
      title={mapping ? 'Edit mapping' : 'Create mapping'}
      onClose={onClose}
      width={720}
      data-testid="rapid-reply-mapping-dialog"
    >
      <DialogContent>
        <Stack sx={{ gap: 2 }}>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <FormControl required>
              <FormLabel>Main model</FormLabel>
              <Select
                value={formData.mainModelId || null}
                onChange={(_, value) => setFormData({ ...formData, mainModelId: value ?? '' })}
                placeholder="Pick a main model"
                data-testid="rapid-reply-mapping-main-model"
              >
                {availableModels.map(model => (
                  <Option key={model.id} value={model.id}>
                    {model.name}
                  </Option>
                ))}
              </Select>
            </FormControl>
            <FormControl required>
              <FormLabel>Rapid model</FormLabel>
              <Select
                value={formData.rapidModelId || null}
                onChange={(_, value) => setFormData({ ...formData, rapidModelId: value ?? '' })}
                placeholder="Pick a rapid model"
                data-testid="rapid-reply-mapping-rapid-model"
              >
                {rapidModels.map(model => {
                  const latency = modelLatency(model.id);
                  return (
                    <Option key={model.id} value={model.id}>
                      <Stack direction="row" sx={{ gap: 1, alignItems: 'center' }}>
                        <span>{model.name}</span>
                        {latency === null ? (
                          <StatusChip tone="neutral" label="No data" />
                        ) : (
                          <StatusChip
                            tone={latency <= maxLatencyThreshold ? 'good' : 'bad'}
                            label={`${Math.round(latency).toLocaleString()} ms`}
                          />
                        )}
                      </Stack>
                    </Option>
                  );
                })}
              </Select>
            </FormControl>
          </Box>

          <FormControl>
            <FormLabel>System prompt</FormLabel>
            <Textarea
              value={formData.systemPrompt}
              onChange={event => setFormData({ ...formData, systemPrompt: event.target.value })}
              minRows={3}
              maxRows={6}
              placeholder="Enter the system prompt for rapid replies"
            />
          </FormControl>

          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' } }}>
            <FormControl>
              <FormLabel>Max tokens</FormLabel>
              <Input
                type="number"
                value={formData.maxTokens}
                onChange={event => setFormData({ ...formData, maxTokens: parseInt(event.target.value) })}
                slotProps={{ input: { min: 10, max: 150 } }}
              />
              <FormHelperText>10 to 150.</FormHelperText>
            </FormControl>
            <FormControl>
              <FormLabel>Response style</FormLabel>
              <Select
                value={formData.responseStyle}
                onChange={(_, value) =>
                  setFormData({ ...formData, responseStyle: (value ?? 'auto') as IRapidReplyMapping['responseStyle'] })
                }
              >
                {Object.values(RapidReplyResponseStylesCommon).map(style => (
                  <Option key={style} value={style}>
                    {style}
                  </Option>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Timeout (ms)</FormLabel>
              <Input
                type="number"
                value={formData.maxLatency}
                onChange={event => setFormData({ ...formData, maxLatency: parseInt(event.target.value) })}
                slotProps={{ input: { min: 500, max: 5000 } }}
              />
              <FormHelperText>500 to 5000. The rapid reply stops after this.</FormHelperText>
            </FormControl>
          </Box>

          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' } }}>
            <FormControl>
              <FormLabel>Fallback priority</FormLabel>
              <Input
                type="number"
                value={formData.priority}
                onChange={event => setFormData({ ...formData, priority: parseInt(event.target.value) })}
                slotProps={{ input: { min: 1, max: 100 } }}
              />
            </FormControl>
            <FormControl>
              <FormLabel>Status</FormLabel>
              <Switch
                checked={Boolean(formData.enabled)}
                onChange={event => setFormData({ ...formData, enabled: event.target.checked })}
                endDecorator={formData.enabled ? 'Enabled' : 'Disabled'}
                sx={{ alignSelf: 'flex-start' }}
                data-testid="rapid-reply-mapping-enabled-switch"
              />
            </FormControl>
          </Box>

          {saveMapping.error && (
            <Typography role="alert" level="body-sm" sx={{ color: 'admin.danger' }}>
              The mapping was not saved: {getErrorMessage(saveMapping.error)}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
        {blockedReason && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mr: 'auto' }}>
            {blockedReason}
          </Typography>
        )}
        <Button variant="plain" color="neutral" onClick={onClose} data-testid="rapid-reply-mapping-cancel-btn">
          Cancel
        </Button>
        <Button
          onClick={() => void handleSave()}
          loading={saveMapping.isPending}
          disabled={Boolean(blockedReason)}
          data-testid="rapid-reply-mapping-save-btn"
        >
          {mapping ? 'Save mapping' : 'Create mapping'}
        </Button>
      </Stack>
    </AdminDialog>
  );
};

/** One "..." menu per row, so the actions fit the table's actions column and Delete is not a button on every row. */
const MappingRowActions: React.FC<{ mapping: IRapidReplyMapping; onEdit: () => void; onDelete: () => void }> = ({
  mapping,
  onEdit,
  onDelete,
}) => (
  <Dropdown>
    <MenuButton
      slots={{ root: IconButton }}
      slotProps={{
        root: {
          size: 'sm',
          variant: 'plain',
          'aria-label': `Actions for the ${mapping.mainModelId} mapping`,
          sx: { ...adminFocus, color: 'admin.inkMuted' },
        },
      }}
      data-testid={`rapid-reply-mapping-actions-${mapping.id}`}
    >
      <MoreHorizIcon sx={{ fontSize: 18 }} />
    </MenuButton>
    <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
      <MenuItem onClick={onEdit} data-testid={`rapid-reply-edit-mapping-${mapping.id}`}>
        Edit mapping
      </MenuItem>
      <MenuItem color="danger" onClick={onDelete} data-testid={`rapid-reply-delete-mapping-${mapping.id}`}>
        Delete mapping
      </MenuItem>
    </Menu>
  </Dropdown>
);

const DeleteMappingDialog: React.FC<{ mapping: IRapidReplyMapping; onClose: () => void }> = ({ mapping, onClose }) => {
  const deleteMapping = useDeleteMapping();
  return (
    <AdminDialog title="Delete mapping" role="alertdialog" onClose={onClose} data-testid="rapid-reply-delete-dialog">
      <DialogContent>
        <Typography>
          {mapping.mainModelId} stops getting rapid replies from {mapping.rapidModelId}, unless another mapping covers
          it. This cannot be undone.
        </Typography>
        {deleteMapping.error && (
          <Typography role="alert" level="body-sm" sx={{ color: 'admin.danger' }}>
            The mapping was not deleted: {getErrorMessage(deleteMapping.error)}
          </Typography>
        )}
      </DialogContent>
      <Stack direction="row" sx={{ gap: 1, justifyContent: 'flex-end' }}>
        <Button variant="plain" color="neutral" onClick={onClose} data-testid="rapid-reply-delete-cancel-btn">
          Cancel
        </Button>
        <Button
          color="danger"
          loading={deleteMapping.isPending}
          onClick={() => deleteMapping.mutate(mapping.id, { onSuccess: onClose })}
          data-testid="rapid-reply-delete-confirm-btn"
        >
          Delete mapping
        </Button>
      </Stack>
    </AdminDialog>
  );
};

const RapidReplyPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<RapidReplyTabKey>('models');
  const [dialog, setDialog] = useState<
    { kind: 'edit'; mapping?: IRapidReplyMapping } | { kind: 'delete'; mapping: IRapidReplyMapping } | null
  >(null);

  const { settings: adminSettings } = useAdminSettingsCache();
  const { data: experimentalSettings } = useExperimentalFeatureSettings();
  const { data: modelInfos } = useModelInfo();
  const mappingsQuery = useRapidReplyMappings();
  const metricsQuery = useRapidReplyMetrics();
  const updateAdminSettings = useUpdateSettings();

  const baselineEnabled =
    experimentalSettings?.find(setting => setting.settingName === 'EnableRapidReply')?.settingValue === 'true';
  const baseline = readPageSettings(adminSettings.RapidReplySettings);

  // The last RapidReplySettings value written, so field drafts saved one after another by the SaveBar
  // each build on the previous write instead of on the baseline from before the save started.
  const written = useRef(baseline);
  const baselineKey = JSON.stringify(baseline);
  useEffect(() => {
    written.current = JSON.parse(baselineKey);
  }, [baselineKey]);
  const writeSettings = async (patch: Partial<RapidReplyPageSettings>) => {
    const next = { ...written.current, ...patch };
    // The setting's type is the full schema; this page has always written only the fields it owns.
    await updateAdminSettings.mutateAsync({ key: 'RapidReplySettings', value: next as RapidReplySettings });
    written.current = next;
  };

  const enabled = useSettingsDraft('EnableRapidReply', baselineEnabled, {
    name: 'Rapid reply',
    save: async value => {
      await updateAdminSettings.mutateAsync({ key: 'EnableRapidReply', value });
      // Turning the feature on or off has always rewritten RapidReplySettings with just this page's fields.
      await writeSettings({});
    },
  });
  const transitionMode = useSettingsDraft('RapidReplySettings.transitionMode', baseline.transitionMode, {
    name: 'Transition mode',
    save: value => writeSettings({ transitionMode: value }),
  });
  const maxLatency = useSettingsDraft('RapidReplySettings.maxAcceptableLatency', baseline.maxAcceptableLatency, {
    name: 'Max acceptable latency',
    save: value => writeSettings({ maxAcceptableLatency: value }),
    blocked: value => outOfRange(value, LATENCY_RANGE, ' ms'),
  });
  const minSuccessRate = useSettingsDraft('RapidReplySettings.minSuccessRate', baseline.minSuccessRate, {
    name: 'Min success rate',
    save: value => writeSettings({ minSuccessRate: value }),
    blocked: value => outOfRange(value, SUCCESS_RATE_RANGE, '%'),
  });

  // Metrics and the mapping dialog read the thresholds as typed, so an admin sees the effect before saving.
  const thresholds = {
    maxLatency: Number.isFinite(maxLatency.value) ? maxLatency.value : baseline.maxAcceptableLatency,
    minSuccessRate: Number.isFinite(minSuccessRate.value) ? minSuccessRate.value : baseline.minSuccessRate,
  };

  const mappings = mappingsQuery.data?.mappings ?? [];
  const unavailableRapidModelIds = mappingsQuery.data?.unavailableRapidModelIds ?? [];

  const mappingColumns: DataColumn<IRapidReplyMapping>[] = [
    { id: 'main', label: 'Main model', render: row => row.mainModelId, sortValue: row => row.mainModelId },
    {
      id: 'rapid',
      label: 'Rapid model',
      sortValue: row => row.rapidModelId,
      render: row => (
        <Stack sx={{ gap: 0.5, alignItems: 'flex-start' }}>
          <span>{row.rapidModelId}</span>
          {/* A rotted row still "works" - the endpoint degrades to a fallback model - so without this
              the only trace is a request-log warn nobody reads. */}
          {unavailableRapidModelIds.includes(row.rapidModelId) && (
            <span title="This model is no longer available (sunset or disabled). Rapid replies for it fall back to another fast model - point the mapping at a current model to control which one.">
              <StatusChip tone="warn" label="Model unavailable" data-testid="rapid-reply-mapping-unavailable-chip" />
            </span>
          )}
        </Stack>
      ),
    },
    {
      id: 'priority',
      label: 'Priority',
      numeric: true,
      width: '6rem',
      render: row => row.priority || undefined,
      sortValue: row => row.priority ?? 0,
    },
    { id: 'maxTokens', label: 'Max tokens', numeric: true, width: '7rem', render: row => row.maxTokens },
    { id: 'style', label: 'Style', width: '8rem', render: row => row.responseStyle },
    {
      id: 'timeout',
      label: 'Timeout (ms)',
      numeric: true,
      width: '8rem',
      render: row => row.maxLatency?.toLocaleString(),
    },
    {
      id: 'status',
      label: 'Status',
      width: '7rem',
      render: row => (
        <StatusChip tone={row.enabled ? 'good' : 'neutral'} label={row.enabled ? 'Enabled' : 'Disabled'} />
      ),
    },
  ];

  const openCreate = () => setDialog({ kind: 'edit' });

  return (
    <>
      <Tabs
        value={activeTab}
        onChange={(_, value) => setActiveTab(value as RapidReplyTabKey)}
        sx={{ bgcolor: 'transparent', gap: ADMIN_REGION_GAP }}
      >
        <TabList sx={adminTabStrip}>
          <Tab value="models" data-testid="rapid-reply-models-tab">
            Models
          </Tab>
          <Tab value="metrics" data-testid="rapid-reply-metrics-tab">
            Metrics
          </Tab>
          <Tab value="test" data-testid="rapid-reply-test-tab">
            Test
          </Tab>
        </TabList>

        <TabPanel value="models" sx={{ p: 0 }}>
          <Stack sx={{ gap: ADMIN_REGION_GAP }}>
            <SettingsSection component="section" sx={{ mb: 0 }} data-testid="rapid-reply-general-section">
              <Typography level="title-md" component="h2" sx={{ color: 'admin.ink', mb: 2 }}>
                General
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fill, minmax(220px, 1fr))' },
                }}
              >
                <FormControl>
                  <FormLabel>Rapid reply</FormLabel>
                  <Switch
                    checked={enabled.value}
                    onChange={event => enabled.setValue(event.target.checked)}
                    endDecorator={enabled.value ? 'On' : 'Off'}
                    disabled={enabled.pending}
                    sx={{ alignSelf: 'flex-start' }}
                    data-testid="rapid-reply-enabled-switch"
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>Transition mode</FormLabel>
                  <Select
                    value={transitionMode.value}
                    onChange={(_, value) => value && transitionMode.setValue(value)}
                    data-testid="rapid-reply-transition-mode-select"
                  >
                    {RapidReplyTransitionModes.map(mode => (
                      <Option key={mode} value={mode} disabled={mode === 'enhance'}>
                        {mode}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl disabled>
                  <FormLabel>Fallback behavior</FormLabel>
                  <Select value={baseline.fallbackBehavior}>
                    {RapidReplyFallbackBehaviors.map(behavior => (
                      <Option key={behavior} value={behavior}>
                        {behavior}
                      </Option>
                    ))}
                  </Select>
                  <FormHelperText>Fixed for now.</FormHelperText>
                </FormControl>
              </Box>
            </SettingsSection>

            <Stack sx={{ gap: 2 }}>
              <AdminPageHeader
                level="section"
                title="Model mappings"
                count={mappingsQuery.data ? mappings.length : undefined}
                description="Which fast model acknowledges a message while each main model writes its answer."
                actions={
                  mappings.length > 0 && (
                    <Button startDecorator={<AddIcon />} onClick={openCreate} data-testid="rapid-reply-new-mapping-btn">
                      New mapping
                    </Button>
                  )
                }
              />
              <DataTable
                rows={mappings}
                columns={mappingColumns}
                getRowId={row => row.id}
                label="Rapid reply model mappings"
                loading={mappingsQuery.isLoading}
                error={mappingsQuery.isError ? 'Model mappings could not be loaded.' : undefined}
                onRetry={() => void mappingsQuery.refetch()}
                empty={
                  <EmptyState
                    title="No model mappings yet"
                    description="Map a main model to a fast model to start sending rapid replies."
                    action={
                      <Button
                        startDecorator={<AddIcon />}
                        onClick={openCreate}
                        data-testid="rapid-reply-create-first-mapping-btn"
                      >
                        Create mapping
                      </Button>
                    }
                  />
                }
                onRowActivate={row => setDialog({ kind: 'edit', mapping: row })}
                rowActions={row => (
                  <MappingRowActions
                    mapping={row}
                    onEdit={() => setDialog({ kind: 'edit', mapping: row })}
                    onDelete={() => setDialog({ kind: 'delete', mapping: row })}
                  />
                )}
                pagination={false}
                minWidth="52rem"
                maxHeight="none"
                testId="rapid-reply-mappings-table"
              />
            </Stack>
          </Stack>
        </TabPanel>

        <TabPanel value="metrics" sx={{ p: 0 }} data-testid="metrics-tab-panel">
          <Stack sx={{ gap: ADMIN_REGION_GAP }}>
            <SettingsSection component="section" sx={{ mb: 0 }} data-testid="rapid-reply-thresholds-section">
              <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
                Performance thresholds
              </Typography>
              <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mb: 2 }}>
                Metrics below flag a model that is slower or less reliable than these.
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fill, minmax(220px, 1fr))' },
                }}
              >
                <FormControl error={Boolean(outOfRange(maxLatency.value, LATENCY_RANGE, ' ms'))}>
                  <FormLabel>Max acceptable latency (ms)</FormLabel>
                  <Input
                    type="number"
                    value={Number.isFinite(maxLatency.value) ? maxLatency.value : ''}
                    onChange={event => maxLatency.setValue(parseNumberInput(event.target.value))}
                    slotProps={{ input: { min: LATENCY_RANGE.min, max: LATENCY_RANGE.max } }}
                    data-testid="rapid-reply-max-latency-input"
                  />
                  <FormHelperText>
                    {LATENCY_RANGE.min} to {LATENCY_RANGE.max}.
                  </FormHelperText>
                </FormControl>
                <FormControl error={Boolean(outOfRange(minSuccessRate.value, SUCCESS_RATE_RANGE, '%'))}>
                  <FormLabel>Min success rate (%)</FormLabel>
                  <Input
                    type="number"
                    value={Number.isFinite(minSuccessRate.value) ? minSuccessRate.value : ''}
                    onChange={event => minSuccessRate.setValue(parseNumberInput(event.target.value))}
                    slotProps={{ input: { min: SUCCESS_RATE_RANGE.min, max: SUCCESS_RATE_RANGE.max } }}
                    data-testid="rapid-reply-min-success-rate-input"
                  />
                  <FormHelperText>
                    {SUCCESS_RATE_RANGE.min} to {SUCCESS_RATE_RANGE.max}.
                  </FormHelperText>
                </FormControl>
              </Box>
            </SettingsSection>

            {metricsQuery.isLoading ? (
              <LoadingState label="Loading rapid reply metrics" />
            ) : metricsQuery.isError && !metricsQuery.data ? (
              <ErrorState
                message="Rapid reply metrics could not be loaded."
                onRetry={() => void metricsQuery.refetch()}
                retrying={metricsQuery.isFetching}
              />
            ) : (
              <RapidReplyMetrics
                metrics={metricsQuery.data}
                thresholds={thresholds}
                onOpenModels={() => setActiveTab('models')}
              />
            )}
          </Stack>
        </TabPanel>

        <TabPanel value="test" sx={{ p: 0 }}>
          <RapidReplyTestPanel models={modelInfos ?? []} />
        </TabPanel>
      </Tabs>

      {dialog?.kind === 'edit' && modelInfos && (
        <MappingDialog
          onClose={() => setDialog(null)}
          mapping={dialog.mapping}
          availableModels={modelInfos}
          metrics={metricsQuery.data}
          maxLatencyThreshold={thresholds.maxLatency}
        />
      )}
      {dialog?.kind === 'delete' && <DeleteMappingDialog mapping={dialog.mapping} onClose={() => setDialog(null)} />}
    </>
  );
};

const RapidReplyTab: React.FC = () => {
  const { isLoading: settingsLoading } = useAdminSettingsCache();
  const { isLoading: flagsLoading } = useExperimentalFeatureSettings();
  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, maxWidth: ADMIN_DETAIL_MAX_WIDTH }} data-testid="admin-rapid-reply-tab">
      <AdminPageHeader
        title="Rapid reply"
        description="A fast model acknowledges each message while the main model writes its answer."
        actions={<ContextHelpButton helpId="admin/rapid-reply" tooltipText="Rapid reply help" />}
      />
      {settingsLoading || flagsLoading ? (
        <LoadingState label="Loading rapid reply settings" />
      ) : (
        // Every setting on the page, across its three views, stages into the provider's one SaveBar.
        <SettingsDraftProvider>
          <RapidReplyPage />
        </SettingsDraftProvider>
      )}
    </Stack>
  );
};

export default RapidReplyTab;
