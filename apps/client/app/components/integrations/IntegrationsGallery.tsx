import { useState, type ReactNode } from 'react';
import { Box, Button, Input, Stack, TabList, Tabs, Typography } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import {
  INTEGRATION_CATEGORY_LABELS,
  MODEL_PROVIDERS,
  MODEL_PROVIDER_KIND_LABELS,
  canAccessTavern,
  type DerivedIntegration,
  type IntegrationCategory,
  type IntegrationId,
  type ModelProvider,
  type ModelProviderKind,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useIntegrationRequests, useToggleIntegrationRequest } from '@client/app/hooks/data/integrationRequests';
import { PageTab, pageTabListSx } from '@client/app/components/common/pageTabs';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import IntegrationLogo from './IntegrationLogo';
import IntegrationDrawer from './IntegrationDrawer';
import { IntegrationStatusLabel, RequestButton, requestCountText } from './IntegrationStatusLabel';
import {
  STATUS_FILTERS,
  STATUS_LABELS,
  categoriesOf,
  countLine,
  deriveGallery,
  filterIntegrations,
  filterModels,
  galleryCounts,
  groupIntegrations,
  groupModels,
  modelKindsOf,
  type ConnectionState,
  type GalleryViewer,
  type StatusFilter,
} from './galleryModel';
import { isConnectable, useIntegrationConnect, useIntegrationConnections } from './useIntegrationConnections';

type GalleryTab = 'integrations' | 'models';

// Logo, name + description, category, status, requests, action. One template for the header
// and every row so the columns line up; phones keep logo, name, status and action.
const ROW_COLUMNS = {
  xs: '28px minmax(0, 1fr) auto',
  md: '28px minmax(0, 1fr) 120px 150px 84px 104px',
};

/** Entries whose drawer carries a setup form, as opposed to a pointer elsewhere. */
const SET_UP_IDS: readonly IntegrationId[] = ['jupyter', 'email', 'blog', 'linkedin'];

const FilterChip = ({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) => (
  <Button
    size="sm"
    variant="outlined"
    color={active ? 'primary' : 'neutral'}
    aria-pressed={active}
    onClick={onClick}
    data-testid={testId}
    sx={{
      '--Button-minHeight': '26px',
      px: '10px',
      fontSize: '12.5px',
      fontWeight: active ? 600 : 400,
      borderRadius: '6px',
      color: active ? undefined : 'text.secondary',
    }}
  >
    {label}
  </Button>
);

const FilterRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <Stack direction="row" alignItems="center" gap="8px" flexWrap="wrap">
    <Typography level="body-xs" sx={{ width: '56px', flexShrink: 0, color: 'text.tertiary' }}>
      {label}
    </Typography>
    {children}
  </Stack>
);

const GroupHeader = ({ label, count, testId }: { label: string; count: number; testId: string }) => (
  <Stack
    direction="row"
    alignItems="baseline"
    gap="10px"
    sx={{ mt: '20px', mb: '4px', px: '10px' }}
    data-testid={testId}
  >
    <Typography
      level="body-xs"
      sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: 'text.tertiary' }}
    >
      {label}
    </Typography>
    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
      {count}
    </Typography>
  </Stack>
);

const rowSx = {
  display: 'grid',
  gridTemplateColumns: ROW_COLUMNS,
  columnGap: '14px',
  alignItems: 'center',
  px: '10px',
  py: '7px',
  borderBottom: '1px solid',
  borderColor: 'divider',
} as const;

const RowText = ({ name, description, muted }: { name: string; description: string; muted: boolean }) => (
  <Stack direction="row" alignItems="baseline" gap="10px" sx={{ minWidth: 0 }}>
    <Typography
      level="body-sm"
      noWrap
      sx={{ fontWeight: 600, fontSize: '13.5px', flexShrink: 0, color: muted ? 'text.secondary' : 'text.primary' }}
    >
      {name}
    </Typography>
    <Typography
      level="body-sm"
      noWrap
      sx={{ display: { xs: 'none', sm: 'block' }, minWidth: 0, fontSize: '13px', color: 'text.secondary' }}
    >
      {description}
    </Typography>
  </Stack>
);

/**
 * The /integrations page body: every integration and model provider in one dense,
 * searchable directory. Statuses come from the registry in @bike4mind/common
 * (deriveIntegrationStatus), connection state from the sources Profile > Integrations reads.
 */
const IntegrationsGallery = () => {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const { isFeatureEnabled } = useAdminSettingsCache();
  // /tavern is a codegen-mounted premium route; the same two-part gate as SidenavNav's Tavern row.
  const tavernRouteExists = premiumRoutes.some(route => route.path.startsWith('/tavern'));
  const viewer: GalleryViewer = {
    isFlagOn: key => isFeatureEnabled(key),
    isAdmin,
    canAccessTavern: tavernRouteExists && canAccessTavern(currentUser),
  };

  const connections = useIntegrationConnections();
  const { connect, isPending } = useIntegrationConnect();
  const { data: requests } = useIntegrationRequests();
  const toggleRequest = useToggleIntegrationRequest();

  const [tab, setTab] = useState<GalleryTab>('integrations');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<IntegrationCategory | 'all'>('all');
  const [modelKind, setModelKind] = useState<ModelProviderKind | 'all'>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [openId, setOpenId] = useState<IntegrationId | null>(null);

  const rows = deriveGallery(viewer, connections);
  const counts = galleryCounts(rows);
  const mine = new Set(requests?.mine ?? []);
  const countOf = (id: IntegrationId) => requests?.counts[id] ?? 0;
  const onToggleRequest = (integrationId: IntegrationId, requested: boolean) =>
    toggleRequest.mutate({ integrationId, requested });

  const changeTab = (next: GalleryTab) => {
    setTab(next);
    setCategory('all');
    setModelKind('all');
    setStatus('all');
  };

  const action = (row: DerivedIntegration, connection: ConnectionState | undefined) => {
    const { id, stage } = row.integration;
    const testId = `integrations-action-btn-${id}`;
    const open = () => setOpenId(id);
    if (stage === 'planned') {
      return (
        <RequestButton
          integrationId={id}
          requested={mine.has(id)}
          onToggle={onToggleRequest}
          testId={`integrations-request-btn-${id}`}
        />
      );
    }
    if (row.status === 'coming-soon') return null;
    const button = (label: string, onClick: () => void, primary = false) => (
      <Button
        size="sm"
        variant={primary ? 'solid' : 'outlined'}
        color={primary ? 'primary' : 'neutral'}
        loading={isPending(id)}
        data-testid={testId}
        onClick={event => {
          event.stopPropagation();
          onClick();
        }}
        sx={{ '--Button-minHeight': '28px', whiteSpace: 'nowrap' }}
      >
        {label}
      </Button>
    );
    if (row.status === 'connected') return button('Manage', open);
    if (isConnectable(id)) return button(connection?.needsReconnect ? 'Reconnect' : 'Connect', () => connect(id), true);
    return button(SET_UP_IDS.includes(id) ? 'Set up' : 'Details', open);
  };

  const integrationRow = (row: DerivedIntegration) => {
    const { integration } = row;
    const planned = integration.stage === 'planned';
    const requestCount = countOf(integration.id);
    return (
      <Box
        key={integration.id}
        role="button"
        tabIndex={0}
        data-testid={`integrations-row-${integration.id}`}
        onClick={() => setOpenId(integration.id)}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpenId(integration.id);
          }
        }}
        sx={theme => ({
          ...rowSx,
          cursor: 'pointer',
          '&:hover': { backgroundColor: theme.palette.background.level1 },
          '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '-2px' },
        })}
      >
        <IntegrationLogo logo={integration.logo} muted={row.status === 'coming-soon'} />
        <Box sx={{ minWidth: 0 }}>
          <RowText name={integration.name} description={integration.description} muted={row.status === 'coming-soon'} />
          <Box sx={{ display: { xs: 'block', md: 'none' }, mt: '2px' }}>
            <IntegrationStatusLabel derived={row} />
          </Box>
        </Box>
        <Typography level="body-xs" noWrap sx={{ display: { xs: 'none', md: 'block' }, color: 'text.tertiary' }}>
          {INTEGRATION_CATEGORY_LABELS[integration.category]}
        </Typography>
        <Box sx={{ display: { xs: 'none', md: 'block' }, minWidth: 0 }}>
          <IntegrationStatusLabel derived={row} testId={`integrations-status-${integration.id}`} />
        </Box>
        <Typography
          level="body-xs"
          noWrap
          data-testid={`integrations-request-count-${integration.id}`}
          sx={{ display: { xs: 'none', md: 'block' }, textAlign: 'right', color: 'text.tertiary' }}
        >
          {planned && requestCount > 0 ? requestCountText(requestCount) : ''}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>{action(row, connections[integration.id])}</Box>
      </Box>
    );
  };

  const modelRow = (model: ModelProvider) => (
    <Box key={model.id} data-testid={`integrations-model-row-${model.id}`} sx={rowSx}>
      <IntegrationLogo logo={model.logo} />
      <RowText name={model.name} description={model.description} muted={false} />
      <Typography level="body-xs" noWrap sx={{ display: { xs: 'none', md: 'block' }, color: 'text.tertiary' }}>
        {MODEL_PROVIDER_KIND_LABELS[model.kind]}
      </Typography>
      <Box sx={{ display: { xs: 'none', md: 'block' } }}>
        <IntegrationStatusLabel derived={{ status: 'available', betaTag: false, adminOnly: false }} />
      </Box>
    </Box>
  );

  const columnHeader = (
    <Box
      aria-hidden
      sx={{
        ...rowSx,
        display: { xs: 'none', md: 'grid' },
        mt: '10px',
        py: '6px',
        '& > span': {
          fontSize: '11.5px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'text.tertiary',
        },
      }}
    >
      <span />
      <span>Name</span>
      <span>{tab === 'models' ? 'Kind' : 'Category'}</span>
      <span>Status</span>
      <span />
      <span />
    </Box>
  );

  const empty = (
    <Typography
      level="body-sm"
      data-testid="integrations-empty"
      sx={{ py: '60px', textAlign: 'center', color: 'text.tertiary' }}
    >
      Nothing matches those filters.
    </Typography>
  );

  const integrationsBody = () => {
    const groups = groupIntegrations(filterIntegrations(rows, { query, category, status }));
    if (groups.length === 0) return empty;
    return (
      <>
        {columnHeader}
        {groups.map(group => (
          <Box key={group.key} data-testid={`integrations-group-${group.key}`}>
            <GroupHeader
              label={group.label}
              count={group.rows.length}
              testId={`integrations-group-header-${group.key}`}
            />
            {group.rows.map(integrationRow)}
          </Box>
        ))}
      </>
    );
  };

  const modelsBody = () => {
    const groups = groupModels(filterModels(MODEL_PROVIDERS, { query, kind: modelKind }));
    if (groups.length === 0) return empty;
    return (
      <>
        {columnHeader}
        {groups.map(group => (
          <Box key={group.key} data-testid={`integrations-model-group-${group.key}`}>
            <GroupHeader
              label={group.label}
              count={group.rows.length}
              testId={`integrations-model-group-header-${group.key}`}
            />
            {group.rows.map(modelRow)}
          </Box>
        ))}
      </>
    );
  };

  const open = openId ? (rows.find(r => r.integration.id === openId) ?? null) : null;

  return (
    <Box data-testid="integrations-page-body">
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto' },
          gap: '16px',
          alignItems: 'end',
        }}
      >
        <Box>
          <Typography level="h2" sx={{ fontWeight: 500, fontSize: '20px' }}>
            Integrations
          </Typography>
          <Typography
            level="body-sm"
            data-testid="integrations-count-line"
            sx={{ mt: '6px', fontSize: '14px', color: 'text.tertiary' }}
          >
            {countLine(counts)}.
          </Typography>
        </Box>
        <Input
          size="sm"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search integrations and models"
          startDecorator={<SearchIcon sx={{ fontSize: '18px' }} />}
          slotProps={{
            input: { 'aria-label': 'Search integrations and models', 'data-testid': 'integrations-search-input' },
          }}
          sx={{ width: { xs: '100%', sm: '280px' }, '--Input-minHeight': '36px' }}
        />
      </Box>

      <Tabs
        value={tab}
        onChange={(_, value) => changeTab(value as GalleryTab)}
        aria-label="Integrations and models"
        sx={{ mt: '16px', backgroundColor: 'transparent' }}
      >
        <TabList sx={pageTabListSx}>
          <PageTab value="integrations" data-testid="integrations-tab-integrations">
            <Typography sx={{ color: 'text.primary' }}>Integrations</Typography>
            <Box component="span" sx={{ ml: '6px', color: 'text.tertiary' }}>
              {counts.integrations}
            </Box>
          </PageTab>
          <PageTab value="models" data-testid="integrations-tab-models">
            <Typography sx={{ color: 'text.primary' }}>Models</Typography>
            <Box component="span" sx={{ ml: '6px', color: 'text.tertiary' }}>
              {counts.models}
            </Box>
          </PageTab>
        </TabList>
      </Tabs>

      <Stack gap="8px" sx={{ mt: '12px', mb: '4px' }}>
        {tab === 'integrations' ? (
          <>
            <FilterRow label="Category">
              <FilterChip
                label="All"
                active={category === 'all'}
                onClick={() => setCategory('all')}
                testId="integrations-category-chip-all"
              />
              {categoriesOf(rows).map(c => (
                <FilterChip
                  key={c}
                  label={INTEGRATION_CATEGORY_LABELS[c]}
                  active={category === c}
                  onClick={() => setCategory(c)}
                  testId={`integrations-category-chip-${c}`}
                />
              ))}
            </FilterRow>
            <FilterRow label="Status">
              {STATUS_FILTERS.map(s => (
                <FilterChip
                  key={s}
                  label={s === 'all' ? 'All' : STATUS_LABELS[s]}
                  active={status === s}
                  onClick={() => setStatus(s)}
                  testId={`integrations-filter-chip-${s}`}
                />
              ))}
            </FilterRow>
          </>
        ) : (
          <FilterRow label="Kind">
            <FilterChip
              label="All"
              active={modelKind === 'all'}
              onClick={() => setModelKind('all')}
              testId="integrations-kind-chip-all"
            />
            {modelKindsOf(MODEL_PROVIDERS).map(k => (
              <FilterChip
                key={k}
                label={MODEL_PROVIDER_KIND_LABELS[k]}
                active={modelKind === k}
                onClick={() => setModelKind(k)}
                testId={`integrations-kind-chip-${k}`}
              />
            ))}
          </FilterRow>
        )}
      </Stack>

      {tab === 'integrations' ? integrationsBody() : modelsBody()}

      <IntegrationDrawer
        derived={open}
        connection={openId ? connections[openId] : undefined}
        connecting={openId ? isPending(openId) : false}
        onConnect={connect}
        requested={openId ? mine.has(openId) : false}
        requestCount={openId ? countOf(openId) : 0}
        onToggleRequest={onToggleRequest}
        onClose={() => setOpenId(null)}
      />
    </Box>
  );
};

export default IntegrationsGallery;
