import { useState } from 'react';
import { Alert, Box, Button, Link, Stack, Tab, TabList, Tabs, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import type { AdminModelRowWire } from '@client/app/hooks/data/adminModels';
import { EntityHeader, StatStrip, StatTile, StatusChip } from '../../shared';
import { ADMIN_MODEL_LOGS_TAB_SLUG, ADMIN_MODEL_METRICS_TAB_SLUG } from '../../adminTabParams';
import { MODEL_LOGS_MODEL_PARAM } from '../../modelLogsTabSearch';
import { MODEL_METRICS_SEARCH_KEYS } from '../../ModelMetrics/modelMetricsSearch';
import { ModelToggleDialog } from '../Access/ModelAccessDialog';
import { effectiveAccess } from '../Access/modelAccessChange';
import { ModelFixAction } from '../ModelFixAction';
import { ModelWriteAction } from '../ModelWriteAction';
import {
  MODEL_STATUS_LABEL,
  MODEL_STATUS_TONE,
  accessSummary,
  modelTypeLabel,
  priceSummary,
} from '../modelPresentation';
import {
  MODEL_DETAIL_TABS,
  MODEL_DETAIL_TAB_LABELS,
  isModelDetailTab,
  type ModelDetailTab,
} from '../modelDetailSearch';
import { useModelsNavigation } from '../modelsNavigation';
import { ModelAccessTab } from './tabs/ModelAccessTab';
import { ModelAdminLogTab } from './tabs/ModelAdminLogTab';
import { ModelOverviewTab } from './tabs/ModelOverviewTab';

const tabId = (tab: ModelDetailTab) => `model-detail-tab-${tab}`;
const panelId = (tab: ModelDetailTab) => `model-detail-panel-${tab}`;

function Breadcrumb({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <Stack
      component="nav"
      aria-label="Breadcrumb"
      direction="row"
      alignItems="center"
      gap={1}
      flexWrap="wrap"
      sx={{ fontSize: 13 }}
    >
      <Link component="button" type="button" onClick={onBack} sx={{ fontSize: 13 }} data-testid="model-detail-back-btn">
        Models
      </Link>
      <Typography level="body-sm" aria-hidden sx={{ color: 'admin.inkMuted' }}>
        /
      </Typography>
      <Typography level="body-sm" aria-current="page" sx={{ color: 'admin.inkMuted', overflowWrap: 'anywhere' }}>
        {name}
      </Typography>
    </Stack>
  );
}

/** One model: header, the reasons it is not listed, and the Overview, Access and Admin log tabs. */
export function ModelDetailView({
  model,
  tab,
  onTabChange,
}: {
  model: AdminModelRowWire;
  tab: ModelDetailTab;
  onTabChange: (tab: ModelDetailTab) => void;
}) {
  const navigate = useNavigate();
  const { openSection } = useModelsNavigation();
  const [toggling, setToggling] = useState<AdminModelRowWire | null>(null);
  const access = effectiveAccess(model.access.entry);
  const summary = accessSummary(model.access);
  const verb = access.enabled ? 'Turn off' : 'Turn on';
  const [first, ...more] = model.reasons;

  const openUsage = () =>
    navigate({
      to: '/admin',
      search: { tab: ADMIN_MODEL_METRICS_TAB_SLUG, [MODEL_METRICS_SEARCH_KEYS.filters.model]: model.id },
    });
  const openLogs = () =>
    navigate({ to: '/admin', search: { tab: ADMIN_MODEL_LOGS_TAB_SLUG, [MODEL_LOGS_MODEL_PARAM]: model.id } });

  const panel = () => {
    switch (tab) {
      case 'overview':
        return <ModelOverviewTab model={model} />;
      case 'access':
        return <ModelAccessTab model={model} />;
      case 'admin':
        return <ModelAdminLogTab modelId={model.id} />;
    }
  };

  return (
    <Stack gap={2.5} data-testid="model-detail-view">
      <Breadcrumb name={model.name} onBack={() => void openSection('list')} />
      <EntityHeader
        title={model.name}
        id={model.id}
        status={
          <StatusChip
            tone={MODEL_STATUS_TONE[model.status]}
            label={MODEL_STATUS_LABEL[model.status]}
            data-testid="model-detail-status"
          />
        }
        meta={
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="model-detail-meta">
            {modelTypeLabel(model.type)} {'\u00b7'} {model.backend}
            {model.releaseDate ? ` \u00b7 Released ${model.releaseDate.slice(0, 10)}` : ''}
          </Typography>
        }
        actions={
          <Stack direction="row" gap={1} flexWrap="wrap">
            <Button size="sm" variant="plain" onClick={() => void openUsage()} data-testid="model-detail-usage-btn">
              Usage
            </Button>
            <Button size="sm" variant="plain" onClick={() => void openLogs()} data-testid="model-detail-logs-btn">
              Logs
            </Button>
            <ModelWriteAction>
              {disabled => (
                <Button
                  size="sm"
                  variant="outlined"
                  disabled={disabled}
                  onClick={() => setToggling(model)}
                  data-testid="model-detail-toggle-btn"
                >
                  {verb}
                </Button>
              )}
            </ModelWriteAction>
          </Stack>
        }
      />
      <StatStrip aria-label="Model at a glance">
        <StatTile
          label="Rank"
          value={model.rank === null ? 'Unranked' : `${model.rank}${model.rankProvisional ? ' (provisional)' : ''}`}
        />
        <StatTile label="Price /1M in/out" value={priceSummary(model.price, model.type)} />
        <StatTile
          label="Access"
          value={summary.label}
          valueColor={summary.adminsOnly ? 'admin.status.bad.foreground' : undefined}
        />
        <StatTile label="Fallback" value={access.fallbackModel || 'Automatic'} />
      </StatStrip>

      {first && (
        <Alert
          color={model.status === 'needs-review' ? 'warning' : 'neutral'}
          variant="soft"
          data-testid="model-detail-reasons"
        >
          <Stack gap={0.75} sx={{ minWidth: 0, flex: 1 }}>
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <Typography level="body-sm" sx={{ fontWeight: 600 }} data-testid="model-detail-reason">
                {first.message}
              </Typography>
              {first.fixAction && (
                <ModelFixAction
                  action={first.fixAction}
                  model={model}
                  onTurnOn={() => setToggling(model)}
                  data-testid="model-detail-fix-btn"
                />
              )}
            </Stack>
            {first.detail && (
              <Typography level="body-xs" sx={{ color: 'admin.inkSecondary', overflowWrap: 'anywhere' }}>
                {first.detail}
              </Typography>
            )}
            {more.map(reason => (
              <Stack key={reason.code} direction="row" gap={1} alignItems="center" flexWrap="wrap">
                <Typography level="body-sm">{reason.message}</Typography>
                {reason.fixAction && (
                  <ModelFixAction
                    action={reason.fixAction}
                    model={model}
                    onTurnOn={() => setToggling(model)}
                    data-testid="model-detail-more-fix-btn"
                  />
                )}
              </Stack>
            ))}
          </Stack>
        </Alert>
      )}

      <Box>
        <Tabs
          value={tab}
          onChange={(_event, next) => {
            if (isModelDetailTab(next)) onTabChange(next);
          }}
          aria-label="Model sections"
          sx={{ bgcolor: 'transparent' }}
        >
          <TabList
            disableUnderline
            sx={{
              gap: 2.5,
              overflowX: 'auto',
              scrollbarWidth: 'none',
              borderBottom: '1px solid',
              borderColor: 'admin.border',
              '--Tab-indicatorThickness': '2px',
              '--Tab-indicatorColor': 'var(--joy-palette-admin-ink)',
            }}
          >
            {MODEL_DETAIL_TABS.map(value => (
              <Tab
                key={value}
                value={value}
                id={tabId(value)}
                aria-controls={value === tab ? panelId(value) : undefined}
                indicatorInset
                data-testid={`model-detail-tab-${value}`}
                sx={{
                  flex: 'none',
                  minHeight: 40,
                  px: 0.5,
                  fontSize: 14,
                  fontWeight: 500,
                  bgcolor: 'transparent',
                  color: 'admin.inkMuted',
                  '&:hover': { bgcolor: 'transparent', color: 'admin.ink' },
                  '&.Mui-selected': { bgcolor: 'transparent', color: 'admin.ink' },
                }}
              >
                {MODEL_DETAIL_TAB_LABELS[value]}
              </Tab>
            ))}
          </TabList>
        </Tabs>
        <Box
          role="tabpanel"
          id={panelId(tab)}
          aria-labelledby={tabId(tab)}
          sx={{ pt: 2.5 }}
          data-testid={`model-detail-panel-${tab}`}
        >
          {panel()}
        </Box>
      </Box>

      {toggling && <ModelToggleDialog model={toggling} onClose={() => setToggling(null)} />}
    </Stack>
  );
}
