import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, FormControl, FormLabel, Input, Option, Select, Stack, Switch, Typography } from '@mui/joy';
import { ADMIN_AI_FEATURES, ADMIN_AI_LADDER_COPY, type AdminAiConfig, type AdminAiFeature } from '@bike4mind/common';
import type { AdminAiOperations } from '@client/server/admin/ai/operations';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { AdminPageHeader } from './shared/AdminPageHeader';
import { StatStrip, StatTile } from './shared/StatStrip';
import { DataTable } from './shared/DataTable';
import { SettingsSection } from './shared/SettingsSection';
import { SaveBar } from './shared/SaveBar';
import { UnsavedChangesGuard } from './shared/UnsavedChangesGuard';
import { ErrorState } from './shared/ErrorState';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

const KEY = ['admin-ai-operations'];
const EMPTY_CLASS = {
  feature: 'feedbackTriage' as AdminAiFeature,
  actionClass: '',
  policyVersion: '',
  mode: 'shadow' as 'off' | 'shadow' | 'recommend' | 'act',
  replayCases: 0,
  replayAgreed: 0,
  replayArtifact: '',
};
async function request<T>(method = 'GET', body?: unknown, path = '/api/admin/ai-operations'): Promise<T> {
  try {
    return (await api.request<T>({ method, url: path, data: body })).data;
  } catch (error) {
    throw new Error(`Could not ${method === 'GET' ? 'load' : 'save'} AI operations: ${getErrorMessage(error)}`);
  }
}
const usd = (value: number) => `$${value.toFixed(4)}`;
const agreement = (accepted: number, overridden: number) =>
  accepted + overridden > 0
    ? `${((accepted / (accepted + overridden)) * 100).toFixed(1)}% (${accepted}/${accepted + overridden})`
    : 'No decisions';

export default function AiOperationsTab() {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: () => request<AdminAiOperations>() });
  const [draft, setDraft] = useState<AdminAiConfig | null>(null);
  const [classDraft, setClassDraft] = useState(EMPTY_CLASS);
  const [classDirty, setClassDirty] = useState(false);
  const save = useMutation({
    mutationFn: (config: AdminAiConfig) => request<AdminAiOperations>('PUT', config),
    onSuccess: data => {
      cache.setQueryData(KEY, data);
      setDraft(null);
    },
  });
  const saveClass = useMutation({
    mutationFn: () => request<AdminAiOperations>('POST', classDraft),
    onSuccess: data => {
      cache.setQueryData(KEY, data);
      setClassDraft(EMPTY_CLASS);
      setClassDirty(false);
    },
  });
  const undo = useMutation({
    mutationFn: ({ path, id }: { path: string; id: string }) => request('POST', { aiSuggestionId: id }, path),
    onSuccess: () => cache.invalidateQueries({ queryKey: KEY }),
  });
  const saving = save.isPending || saveClass.isPending;
  const data = query.data;
  const config = draft ?? data?.config;
  const configDirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(data?.config));
  const dirty = configDirty || classDirty;
  const editClass = (change: Partial<typeof classDraft>) => {
    setClassDraft(previous => ({ ...previous, ...change }));
    setClassDirty(true);
  };
  const edit = (change: Partial<AdminAiConfig>) => {
    if (config) setDraft({ ...config, ...change });
  };
  const editFeature = (feature: AdminAiFeature, change: Partial<AdminAiConfig['features'][AdminAiFeature]>) => {
    if (config) edit({ features: { ...config.features, [feature]: { ...config.features[feature], ...change } } });
  };
  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="AI operations"
        description="Spend, agreement and safe controls for admin AI. The console stays manual when AI is off."
        actions={
          <Button variant="outlined" onClick={() => query.refetch()} data-testid="ai-operations-refresh-btn">
            Refresh
          </Button>
        }
      />
      {query.isError && <ErrorState message={query.error.message} onRetry={() => query.refetch()} />}
      {data && config && (
        <>
          {data.budgetState !== 'normal' && (
            <Alert color="warning" data-testid="ai-operations-budget-alert">
              {data.budgetState === 'stopped'
                ? 'Monthly cap reached or zero: AI calls stop. All manual controls remain available.'
                : 'Known spend is at least 80% of the monthly cap.'}
            </Alert>
          )}
          <StatStrip>
            <StatTile
              label="Known spend this month"
              value={usd(data.monthUsd)}
              comparison={`Cap ${usd(config.monthlyCapUsd)}`}
            />
            <StatTile label="Calls today" value={data.features.reduce((sum, row) => sum + row.callsToday, 0)} />
            <StatTile
              label="Unknown-cost attempts"
              value={data.features.reduce((sum, row) => sum + row.unknownCostAttempts, 0)}
            />
          </StatStrip>
          <Typography level="body-sm">{data.coverage}</Typography>
          <SettingsSection>
            <Stack gap={2}>
              <Typography level="title-md">Global controls</Typography>
              <FormControl orientation="horizontal">
                <FormLabel>Enable admin AI</FormLabel>
                <Switch
                  disabled={saving}
                  checked={config.enabled}
                  onChange={event => edit({ enabled: event.target.checked })}
                  slotProps={{ input: { 'data-testid': 'ai-operations-global-switch' } }}
                />
              </FormControl>
              <FormControl>
                <FormLabel>Monthly cap (USD)</FormLabel>
                <Input
                  disabled={saving}
                  type="number"
                  value={config.monthlyCapUsd}
                  onChange={event => edit({ monthlyCapUsd: Number(event.target.value) })}
                  slotProps={{ input: { min: 0, max: 1000, step: 1, 'data-testid': 'ai-operations-monthly-cap' } }}
                />
              </FormControl>
            </Stack>
          </SettingsSection>
          <DataTable
            rows={data.features}
            getRowId={row => row.feature}
            label="AI feature metrics"
            onRetry={() => query.refetch()}
            columns={[
              { id: 'feature', label: 'Feature', render: row => row.feature },
              { id: 'mode', label: 'Mode', render: row => row.mode },
              {
                id: 'today',
                label: 'Today / daily cap',
                numeric: true,
                render: row => `${usd(row.todayUsd)} / ${usd(config.features[row.feature].dailyBudgetUsd)}`,
              },
              { id: 'month', label: 'This month', numeric: true, render: row => usd(row.monthUsd) },
              {
                id: 'calls',
                label: 'Calls / daily cap',
                numeric: true,
                render: row => `${row.callsToday} / ${config.features[row.feature].maxCallsPerDay}`,
              },
              {
                id: 'skip',
                label: 'Skips (30 days)',
                render: row => row.skips.map(skip => `${skip.reason}: ${skip.count}`).join(', ') || 'None recorded',
              },
              {
                id: 'agreement7',
                label: 'Agreement (7 days)',
                numeric: true,
                render: row => agreement(row.accepted7, row.overridden7),
              },
              {
                id: 'agreement30',
                label: 'Agreement (30 days)',
                numeric: true,
                render: row => agreement(row.accepted30, row.overridden30),
              },
            ]}
          />
          <SettingsSection>
            <Typography level="title-md">Feature controls</Typography>
            <Stack gap={2}>
              {ADMIN_AI_FEATURES.map(feature => (
                <Stack key={feature} gap={1}>
                  <Typography level="title-sm">{feature}</Typography>
                  <Stack direction="row" flexWrap="wrap" gap={2}>
                    <FormControl orientation="horizontal">
                      <FormLabel>Enabled</FormLabel>
                      <Switch
                        disabled={saving}
                        checked={config.features[feature].mode !== 'off'}
                        onChange={event => editFeature(feature, { mode: event.target.checked ? 'shadow' : 'off' })}
                        slotProps={{ input: { 'data-testid': `ai-operations-${feature}-switch` } }}
                      />
                    </FormControl>
                    <FormControl>
                      <FormLabel>Mode</FormLabel>
                      <Select
                        disabled={saving}
                        value={config.features[feature].mode}
                        data-testid={`ai-operations-${feature}-mode`}
                        onChange={(_, mode) => {
                          if (mode) editFeature(feature, { mode });
                        }}
                      >
                        <Option value="off">Off</Option>
                        <Option value="shadow">Shadow</Option>
                        <Option
                          value="recommend"
                          disabled={!data.classes.some(cls => cls.evidence.feature === feature && cls.recommend)}
                        >
                          Recommend (replay required)
                        </Option>
                        <Option
                          value="act"
                          disabled={!data.classes.some(cls => cls.evidence.feature === feature && cls.act)}
                        >
                          Act (registered action required)
                        </Option>
                      </Select>
                    </FormControl>
                    <FormControl>
                      <FormLabel>Daily budget (USD)</FormLabel>
                      <Input
                        disabled={saving}
                        type="number"
                        value={config.features[feature].dailyBudgetUsd}
                        onChange={event => editFeature(feature, { dailyBudgetUsd: Number(event.target.value) })}
                        slotProps={{ input: { min: 0, step: 0.1, 'data-testid': `ai-operations-${feature}-budget` } }}
                      />
                    </FormControl>
                    <FormControl>
                      <FormLabel>Daily call cap</FormLabel>
                      <Input
                        disabled={saving}
                        type="number"
                        value={config.features[feature].maxCallsPerDay}
                        onChange={event => editFeature(feature, { maxCallsPerDay: Number(event.target.value) })}
                        slotProps={{ input: { min: 0, step: 1, 'data-testid': `ai-operations-${feature}-calls` } }}
                      />
                    </FormControl>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </SettingsSection>
          <SettingsSection>
            <Typography level="title-md">Autonomy ladder</Typography>
            <Typography>{ADMIN_AI_LADDER_COPY}</Typography>
            <Typography level="body-sm">
              Money, credits, access restrictions, deletions, outbound messages, legal reports, security controls,
              settings, prompts and audit review always require a person. No image moderation AI.
            </Typography>
            <Typography level="body-sm">
              No action handlers are registered by default. Class evidence is policy-versioned and recorded through the
              audited operations API.
            </Typography>
          </SettingsSection>
          <SettingsSection>
            <Stack gap={2}>
              <Typography level="title-md">Class evidence and mode</Typography>
              <Typography level="body-sm">
                Record a reproducible offline replay artifact, case count and agreement count. Policy changes require
                fresh evidence. This does not register an action handler.
              </Typography>
              <FormControl>
                <FormLabel>Feature</FormLabel>
                <Select
                  disabled={saving}
                  value={classDraft.feature}
                  data-testid="ai-operations-class-feature"
                  onChange={(_, feature) => {
                    if (feature) editClass({ feature });
                  }}
                >
                  {ADMIN_AI_FEATURES.map(feature => (
                    <Option key={feature} value={feature}>
                      {feature}
                    </Option>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>Action class</FormLabel>
                <Input
                  disabled={saving}
                  value={classDraft.actionClass}
                  onChange={event => editClass({ actionClass: event.target.value })}
                  data-testid="ai-operations-class-name"
                />
              </FormControl>
              <FormControl>
                <FormLabel>Policy version</FormLabel>
                <Input
                  disabled={saving}
                  value={classDraft.policyVersion}
                  onChange={event => editClass({ policyVersion: event.target.value })}
                  data-testid="ai-operations-class-policy"
                />
              </FormControl>
              <FormControl>
                <FormLabel>Replay artifact reference</FormLabel>
                <Input
                  disabled={saving}
                  value={classDraft.replayArtifact}
                  onChange={event => editClass({ replayArtifact: event.target.value })}
                  data-testid="ai-operations-class-artifact"
                />
              </FormControl>
              <FormControl>
                <FormLabel>Replay cases</FormLabel>
                <Input
                  disabled={saving}
                  type="number"
                  value={classDraft.replayCases}
                  onChange={event => editClass({ replayCases: Number(event.target.value) })}
                  data-testid="ai-operations-class-cases"
                />
              </FormControl>
              <FormControl>
                <FormLabel>Agreed cases</FormLabel>
                <Input
                  disabled={saving}
                  type="number"
                  value={classDraft.replayAgreed}
                  onChange={event => editClass({ replayAgreed: Number(event.target.value) })}
                  data-testid="ai-operations-class-agreed"
                />
              </FormControl>
              <FormControl>
                <FormLabel>Class mode</FormLabel>
                <Select
                  disabled={saving}
                  value={classDraft.mode}
                  data-testid="ai-operations-class-mode"
                  onChange={(_, mode) => {
                    if (mode) editClass({ mode });
                  }}
                >
                  <Option value="off">Off</Option>
                  <Option value="shadow">Shadow</Option>
                  <Option value="recommend">Recommend (replay required)</Option>
                  <Option value="act" disabled>
                    Act unavailable: no registered handler
                  </Option>
                </Select>
              </FormControl>
            </Stack>
          </SettingsSection>
          <DataTable
            rows={data.classes}
            getRowId={row => `${row.evidence.feature}:${row.evidence.actionClass}:${row.evidence.policyVersion}`}
            label="Class readiness"
            onRetry={() => query.refetch()}
            empty={<Typography>No class evidence recorded. All classes remain unavailable for act.</Typography>}
            columns={[
              {
                id: 'class',
                label: 'Class / policy',
                render: row => `${row.evidence.feature}/${row.evidence.actionClass} (${row.evidence.policyVersion})`,
              },
              { id: 'mode', label: 'Mode', render: row => row.mode },
              {
                id: 'replay',
                label: 'Offline replay',
                render: row => `${row.evidence.replayAgreed}/${row.evidence.replayCases}`,
              },
              {
                id: 'online',
                label: 'Online agreement',
                render: row => agreement(row.evidence.onlineAccepted, row.evidence.onlineOverridden),
              },
              { id: 'act', label: 'Act readiness', render: row => (row.act ? 'Eligible' : 'Unavailable') },
            ]}
          />
          {undo.isError && <Alert color="danger">Undo failed. No success was recorded.</Alert>}
          <DataTable
            rows={data.recent}
            getRowId={row => row.id}
            label="Recent overrides and automatic actions"
            onRetry={() => query.refetch()}
            empty={<Typography>No overrides or automatic actions recorded.</Typography>}
            columns={[
              { id: 'feature', label: 'Feature', render: row => row.feature },
              { id: 'entity', label: 'Entity', render: row => row.entityId },
              { id: 'status', label: 'Status', render: row => row.status },
              { id: 'reason', label: 'Override reason', render: row => row.overrideReason || 'Not recorded' },
              {
                id: 'time',
                label: 'Decided',
                render: row => (row.decidedAt ? new Date(row.decidedAt).toLocaleString() : 'Not recorded'),
              },
              {
                id: 'undo',
                label: 'Recovery',
                render: row =>
                  row.status === 'auto_applied' ? (
                    <Button
                      variant="plain"
                      disabled={!row.undoPath}
                      loading={undo.isPending}
                      data-testid={`ai-operations-undo-${row.id}-btn`}
                      onClick={() => {
                        if (row.undoPath) undo.mutate({ path: row.undoPath, id: row.id });
                      }}
                    >
                      Undo{!row.undoPath ? ' unavailable: no registered handler' : ''}
                    </Button>
                  ) : null,
              },
            ]}
          />
          <SaveBar
            count={Number(configDirty) + Number(classDirty)}
            pending={saving}
            error={save.error?.message ?? saveClass.error?.message}
            onSave={async () => {
              try {
                if (classDirty) await saveClass.mutateAsync();
                if (configDirty) await save.mutateAsync(config);
              } catch {
                /* Errors remain on the save bar. */
              }
            }}
            onDiscard={() => {
              setDraft(null);
              setClassDraft(EMPTY_CLASS);
              setClassDirty(false);
            }}
          />
          <UnsavedChangesGuard
            dirty={dirty}
            pending={saving}
            isLeaving={(current, next) =>
              current.pathname !== next.pathname || JSON.stringify(current.search) !== JSON.stringify(next.search)
            }
          />
        </>
      )}
      {!data && !query.isError && (
        <DataTable
          rows={[]}
          columns={[]}
          getRowId={() => ''}
          label="AI operations"
          loading
          onRetry={() => query.refetch()}
        />
      )}
    </Stack>
  );
}
