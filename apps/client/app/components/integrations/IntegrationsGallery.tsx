import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Box, Button, Input, Option, Select, Skeleton, Stack, TabList, Tabs, Typography } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import {
  INTEGRATION_CATEGORY_LABELS,
  IntegrationsEvents,
  MODEL_PROVIDERS,
  MODEL_PROVIDER_KIND_LABELS,
  buildIntegrationsSearchMetadata,
  canAccessTavern,
  normalizeIntegrationsSearchQuery,
  type DerivedIntegration,
  type DerivedIntegrationStatus,
  type IntegrationCategory,
  type IntegrationId,
  type IntegrationsGalleryFilter,
  type IntegrationsPageSource,
  type ModelProvider,
  type ModelProviderKind,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useIsTablet } from '@client/app/hooks/useIsMobile';
import { useIntegrationRequests } from '@client/app/hooks/data/integrationRequests';
import { useLogEvent } from '@client/app/hooks/data/analytics';
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
import {
  isConnectable,
  useIntegrationConnect,
  useIntegrationConnections,
  type ConnectableId,
} from './useIntegrationConnections';

type GalleryTab = 'integrations' | 'models';

/** Entries whose drawer carries a setup form, as opposed to a pointer elsewhere. */
const SET_UP_IDS: readonly IntegrationId[] = ['jupyter', 'email', 'blog', 'linkedin'];

const MODEL_STATUS: DerivedIntegrationStatus = { status: 'available', betaTag: false, adminOnly: false };

/** How long the search box must sit still before the query is recorded as a search. */
export const SEARCH_SETTLE_MS = 800;

interface FilterOption<T extends string> {
  value: T;
  label: string;
  count: number;
}

/**
 * One filter as a compact select: the button names the active value and the list shows how
 * many entries each value holds. An active filter takes the accent.
 */
function FilterSelect<T extends string>({
  name,
  allLabel,
  value,
  options,
  total,
  onChange,
  testId,
  disabled,
}: {
  name: string;
  allLabel: string;
  value: T | 'all';
  options: FilterOption<T>[];
  total: number;
  onChange: (value: T | 'all') => void;
  testId: string;
  disabled?: boolean;
}) {
  const active = value !== 'all';
  const activeLabel = options.find(option => option.value === value)?.label;
  const optionBody = (label: string, count: number) => (
    <Stack direction="row" justifyContent="space-between" gap="16px" sx={{ width: '100%' }}>
      <span>{label}</span>
      <Box component="span" sx={{ color: 'text.tertiary' }}>
        {count}
      </Box>
    </Stack>
  );
  return (
    <Select<T | 'all'>
      size="sm"
      variant="outlined"
      color={active ? 'primary' : 'neutral'}
      disabled={disabled}
      value={value}
      onChange={(_, next) => {
        if (next !== null) onChange(next);
      }}
      renderValue={() => (active ? `${name}: ${activeLabel}` : allLabel)}
      slotProps={{
        button: { 'data-testid': `${testId}-filter-btn` },
        listbox: { placement: 'bottom-end', sx: { minWidth: '200px' } },
      }}
      sx={{ '--Select-minHeight': '36px', flex: { xs: '1 1 0', sm: '0 0 auto' }, minWidth: { sm: '150px' } }}
    >
      <Option value="all" label={allLabel} data-testid={`${testId}-option-all`}>
        {optionBody(allLabel, total)}
      </Option>
      {options.map(option => (
        <Option
          key={option.value}
          value={option.value}
          label={option.label}
          data-testid={`${testId}-option-${option.value}`}
        >
          {optionBody(option.label, option.count)}
        </Option>
      ))}
    </Select>
  );
}

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

// Logo, name + description, category, status, requests, action. One template for the column
// header and every row so the columns line up. Rows are desktop only; below md the page uses cards.
const rowSx = {
  display: 'grid',
  gridTemplateColumns: '28px minmax(0, 1fr) 120px 150px 84px 104px',
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
    <Typography level="body-sm" noWrap sx={{ minWidth: 0, fontSize: '13px', color: 'text.secondary' }}>
      {description}
    </Typography>
  </Stack>
);

const cardGridSx = {
  display: 'grid',
  gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
  gap: '12px',
  mt: '4px',
} as const;

// Roadmap cards drop the fill and dash the border so they read as not-yet at a glance.
const cardSx = (soon: boolean) =>
  ({
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    p: '16px',
    borderRadius: '12px',
    border: '1px solid',
    borderStyle: soon ? 'dashed' : 'solid',
    borderColor: 'divider',
    backgroundColor: soon ? 'transparent' : 'background.surface',
  }) as const;

const CardHead = ({ logo, name, sub, muted }: { logo: ReactNode; name: string; sub: string; muted: boolean }) => (
  <Stack direction="row" alignItems="center" gap="12px" sx={{ minWidth: 0 }}>
    {logo}
    <Box sx={{ minWidth: 0 }}>
      <Typography
        level="title-sm"
        noWrap
        sx={{ fontSize: '15px', fontWeight: 600, color: muted ? 'text.secondary' : 'text.primary' }}
      >
        {name}
      </Typography>
      <Typography level="body-xs" noWrap sx={{ color: 'text.tertiary' }}>
        {sub}
      </Typography>
    </Box>
  </Stack>
);

const CardText = ({ children }: { children: ReactNode }) => (
  <Typography level="body-sm" sx={{ flex: 1, fontSize: '13.5px', color: 'text.secondary' }}>
    {children}
  </Typography>
);

const LOADING_ROW_COUNT = 8;

/** Rows and cards in the shapes they give way to, so the page does not jump when settings arrive. */
const LoadingPlaceholder = ({ compact }: { compact: boolean }) => (
  <Box data-testid="integrations-loading" role="status" aria-label="Loading integrations" sx={{ mt: '10px' }}>
    {compact ? (
      <Box sx={cardGridSx}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} variant="rectangular" height={132} sx={{ borderRadius: '12px' }} />
        ))}
      </Box>
    ) : (
      Array.from({ length: LOADING_ROW_COUNT }, (_, i) => (
        <Box key={i} sx={rowSx}>
          <Skeleton variant="circular" width={28} height={28} />
          <Skeleton variant="text" width="45%" />
          <Skeleton variant="text" width="70%" />
          <Skeleton variant="text" width="60%" />
          <span />
          <Skeleton variant="rectangular" height={28} sx={{ borderRadius: '6px' }} />
        </Box>
      ))
    )}
  </Box>
);

/**
 * The /integrations page body: every integration and model provider in one searchable
 * directory, as dense rows on desktop and a card grid below md. Statuses come from the registry
 * in @bike4mind/common (deriveIntegrationStatus), connection state from the sources Profile >
 * Integrations reads. Usage is recorded through useLogEvent (IntegrationsEvents in @bike4mind/common);
 * `source` names the entry point the page was opened from.
 */
const IntegrationsGallery = ({ source = 'direct' }: { source?: IntegrationsPageSource }) => {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const {
    isFeatureEnabled,
    isLoading: settingsLoading,
    authedSettingsLoaded,
    error: settingsError,
  } = useAdminSettingsCache();
  // Until the authenticated fetch lands (or fails) every non-public flag reads as its compiled-in
  // default, which would draw wrong statuses and then re-sort the page; show placeholders instead.
  const flagsReady = !settingsLoading && (authedSettingsLoaded || !!settingsError);
  const compact = useIsTablet();
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
  const { mutate: logEvent } = useLogEvent();

  const [tab, setTab] = useState<GalleryTab>('integrations');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<IntegrationCategory | 'all'>('all');
  const [modelKind, setModelKind] = useState<ModelProviderKind | 'all'>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [openId, setOpenId] = useState<IntegrationId | null>(null);

  const rows = deriveGallery(viewer, connections);
  const counts = galleryCounts(rows);
  const visibleIntegrations = filterIntegrations(rows, { query, category, status });
  const visibleModels = filterModels(MODEL_PROVIDERS, { query, kind: modelKind });
  const resultCount = tab === 'integrations' ? visibleIntegrations.length : visibleModels.length;
  const mine = new Set(requests?.mine ?? []);
  const countOf = (id: IntegrationId) => requests?.counts[id] ?? 0;

  // A ref, not the dependency array, keeps this to one view per mount: StrictMode re-runs effects,
  // and the page strips `?source=` right after, which changes the prop.
  const viewLogged = useRef(false);
  useEffect(() => {
    if (viewLogged.current) return;
    viewLogged.current = true;
    logEvent({ type: IntegrationsEvents.INTEGRATIONS_PAGE_VIEWED, metadata: { entryPoint: source } });
  }, [logEvent, source]);

  // Recorded once the query settles. A filter or tab change while it settles restarts the wait, so
  // resultCount is what the user is looking at; re-reading the same query records nothing new.
  const lastLoggedQuery = useRef('');
  useEffect(() => {
    const normalized = normalizeIntegrationsSearchQuery(query);
    if (!normalized) {
      lastLoggedQuery.current = '';
      return;
    }
    if (normalized === lastLoggedQuery.current) return;
    const timer = setTimeout(() => {
      lastLoggedQuery.current = normalized;
      logEvent({
        type: IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED,
        metadata: buildIntegrationsSearchMetadata(query, resultCount, tab),
      });
    }, SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query, resultCount, tab, logEvent]);

  const openDrawer = (integrationId: IntegrationId) => {
    setOpenId(integrationId);
    logEvent({ type: IntegrationsEvents.INTEGRATIONS_CARD_OPENED, metadata: { integrationId } });
  };
  const onConnect = (integrationId: ConnectableId) => {
    logEvent({ type: IntegrationsEvents.INTEGRATIONS_CONNECT_CLICKED, metadata: { integrationId } });
    connect(integrationId);
  };
  // `requested` is the state before the click, so the event records its opposite.
  const onToggleRequest = (integrationId: IntegrationId, requested: boolean) => {
    logEvent({
      type: IntegrationsEvents.INTEGRATIONS_REQUEST_TOGGLED,
      metadata: { integrationId, requested: !requested },
    });
  };
  const changeFilter =
    <T extends string>(filter: IntegrationsGalleryFilter, set: (value: T) => void) =>
    (value: T) => {
      set(value);
      logEvent({ type: IntegrationsEvents.INTEGRATIONS_FILTER_CHANGED, metadata: { filter, value } });
    };

  const changeTab = (next: GalleryTab) => {
    setTab(next);
    setCategory('all');
    setModelKind('all');
    setStatus('all');
  };

  const action = (row: DerivedIntegration, connection: ConnectionState | undefined) => {
    const { id, stage } = row.integration;
    const testId = `integrations-action-btn-${id}`;
    const open = () => openDrawer(id);
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
    if (isConnectable(id)) {
      return button(connection?.needsReconnect ? 'Reconnect' : 'Connect', () => onConnect(id), true);
    }
    return button(SET_UP_IDS.includes(id) ? 'Set up' : 'Details', open);
  };

  // Rows and cards open the drawer on click, Enter or Space; the buttons inside stop propagation.
  const openerProps = (id: IntegrationId, testId: string) => ({
    role: 'button',
    tabIndex: 0,
    'data-testid': testId,
    onClick: () => openDrawer(id),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDrawer(id);
      }
    },
  });

  const requestCount = (row: DerivedIntegration): string => {
    const count = countOf(row.integration.id);
    return row.integration.stage === 'planned' && count > 0 ? requestCountText(count) : '';
  };

  const integrationRow = (row: DerivedIntegration) => {
    const { integration } = row;
    const soon = row.status === 'coming-soon';
    return (
      <Box
        key={integration.id}
        {...openerProps(integration.id, `integrations-row-${integration.id}`)}
        sx={theme => ({
          ...rowSx,
          cursor: 'pointer',
          '&:hover': { backgroundColor: theme.palette.background.level1 },
          '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '-2px' },
        })}
      >
        <IntegrationLogo logo={integration.logo} muted={soon} />
        <RowText name={integration.name} description={integration.description} muted={soon} />
        <Typography level="body-xs" noWrap sx={{ color: 'text.tertiary' }}>
          {INTEGRATION_CATEGORY_LABELS[integration.category]}
        </Typography>
        <Box sx={{ minWidth: 0 }}>
          <IntegrationStatusLabel derived={row} testId={`integrations-status-${integration.id}`} />
        </Box>
        <Typography
          level="body-xs"
          noWrap
          data-testid={`integrations-request-count-${integration.id}`}
          sx={{ textAlign: 'right', color: 'text.tertiary' }}
        >
          {requestCount(row)}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>{action(row, connections[integration.id])}</Box>
      </Box>
    );
  };

  const integrationCard = (row: DerivedIntegration) => {
    const { integration } = row;
    const soon = row.status === 'coming-soon';
    const count = requestCount(row);
    return (
      <Box
        key={integration.id}
        {...openerProps(integration.id, `integrations-card-${integration.id}`)}
        sx={theme => ({
          ...cardSx(soon),
          cursor: 'pointer',
          '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '2px' },
        })}
      >
        <CardHead
          logo={<IntegrationLogo logo={integration.logo} size={44} muted={soon} />}
          name={integration.name}
          sub={INTEGRATION_CATEGORY_LABELS[integration.category]}
          muted={soon}
        />
        <CardText>{integration.description}</CardText>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap="8px">
          <IntegrationStatusLabel derived={row} testId={`integrations-status-${integration.id}`} />
          <Stack direction="row" alignItems="center" gap="10px">
            {count && (
              <Typography
                level="body-xs"
                noWrap
                data-testid={`integrations-request-count-${integration.id}`}
                sx={{ color: 'text.tertiary' }}
              >
                {count}
              </Typography>
            )}
            {action(row, connections[integration.id])}
          </Stack>
        </Stack>
      </Box>
    );
  };

  const modelRow = (model: ModelProvider) => (
    <Box key={model.id} data-testid={`integrations-model-row-${model.id}`} sx={rowSx}>
      <IntegrationLogo logo={model.logo} />
      <RowText name={model.name} description={model.description} muted={false} />
      <Typography level="body-xs" noWrap sx={{ color: 'text.tertiary' }}>
        {MODEL_PROVIDER_KIND_LABELS[model.kind]}
      </Typography>
      <IntegrationStatusLabel derived={MODEL_STATUS} />
    </Box>
  );

  const modelCard = (model: ModelProvider) => (
    <Box key={model.id} data-testid={`integrations-model-card-${model.id}`} sx={cardSx(false)}>
      <CardHead
        logo={<IntegrationLogo logo={model.logo} size={44} />}
        name={model.name}
        sub={MODEL_PROVIDER_KIND_LABELS[model.kind]}
        muted={false}
      />
      <CardText>{model.description}</CardText>
      <IntegrationStatusLabel derived={MODEL_STATUS} />
    </Box>
  );

  const columnHeader = (
    <Box
      aria-hidden
      sx={{
        ...rowSx,
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

  function groupBody<T>(items: T[], asRow: (item: T) => ReactNode, asCard: (item: T) => ReactNode) {
    return compact ? <Box sx={cardGridSx}>{items.map(asCard)}</Box> : items.map(asRow);
  }

  const integrationsBody = () => {
    if (!flagsReady) return <LoadingPlaceholder compact={compact} />;
    const groups = groupIntegrations(visibleIntegrations);
    if (groups.length === 0) return empty;
    return (
      <>
        {!compact && columnHeader}
        {groups.map(group => (
          <Box key={group.key} data-testid={`integrations-group-${group.key}`}>
            <GroupHeader
              label={group.label}
              count={group.rows.length}
              testId={`integrations-group-header-${group.key}`}
            />
            {groupBody(group.rows, integrationRow, integrationCard)}
          </Box>
        ))}
      </>
    );
  };

  const modelsBody = () => {
    const groups = groupModels(visibleModels);
    if (groups.length === 0) return empty;
    return (
      <>
        {!compact && columnHeader}
        {groups.map(group => (
          <Box key={group.key} data-testid={`integrations-model-group-${group.key}`}>
            <GroupHeader
              label={group.label}
              count={group.rows.length}
              testId={`integrations-model-group-header-${group.key}`}
            />
            {groupBody(group.rows, modelRow, modelCard)}
          </Box>
        ))}
      </>
    );
  };

  const filters =
    tab === 'integrations' ? (
      <>
        <FilterSelect<IntegrationCategory>
          name="Category"
          allLabel="All categories"
          value={category}
          options={categoriesOf(rows).map(c => ({
            value: c,
            label: INTEGRATION_CATEGORY_LABELS[c],
            count: rows.filter(r => r.integration.category === c).length,
          }))}
          total={rows.length}
          onChange={changeFilter<IntegrationCategory | 'all'>('category', setCategory)}
          testId="integrations-category"
          disabled={!flagsReady}
        />
        <FilterSelect<Exclude<StatusFilter, 'all'>>
          name="Status"
          allLabel="All statuses"
          value={status}
          options={STATUS_FILTERS.filter(s => s !== 'all').map(s => ({
            value: s,
            label: STATUS_LABELS[s],
            count: filterIntegrations(rows, { query: '', category: 'all', status: s }).length,
          }))}
          total={rows.length}
          onChange={changeFilter<StatusFilter>('status', setStatus)}
          testId="integrations-status"
          disabled={!flagsReady}
        />
      </>
    ) : (
      <FilterSelect<ModelProviderKind>
        name="Kind"
        allLabel="All kinds"
        value={modelKind}
        options={modelKindsOf(MODEL_PROVIDERS).map(k => ({
          value: k,
          label: MODEL_PROVIDER_KIND_LABELS[k],
          count: MODEL_PROVIDERS.filter(m => m.kind === k).length,
        }))}
        total={MODEL_PROVIDERS.length}
        onChange={changeFilter<ModelProviderKind | 'all'>('kind', setModelKind)}
        testId="integrations-kind"
      />
    );

  const open = openId ? (rows.find(r => r.integration.id === openId) ?? null) : null;

  return (
    <Box data-testid="integrations-page-body">
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        gap="16px"
        alignItems={{ xs: 'stretch', md: 'flex-end' }}
        justifyContent="space-between"
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
            {flagsReady ? `${countLine(counts)}.` : <Skeleton variant="inline" width={260} />}
          </Typography>
        </Box>
        <Stack direction="row" gap="8px" flexWrap="wrap" data-testid="integrations-filters">
          <Input
            size="sm"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search integrations and models"
            startDecorator={<SearchIcon sx={{ fontSize: '18px' }} />}
            slotProps={{
              input: { 'aria-label': 'Search integrations and models', 'data-testid': 'integrations-search-input' },
            }}
            sx={{ flex: { xs: '1 1 100%', sm: '0 0 260px' }, '--Input-minHeight': '36px' }}
          />
          {filters}
        </Stack>
      </Stack>

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
              {flagsReady ? counts.integrations : ''}
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

      {tab === 'integrations' ? integrationsBody() : modelsBody()}

      <IntegrationDrawer
        derived={open}
        connection={openId ? connections[openId] : undefined}
        connecting={openId ? isPending(openId) : false}
        onConnect={onConnect}
        requested={openId ? mine.has(openId) : false}
        requestCount={openId ? countOf(openId) : 0}
        onToggleRequest={onToggleRequest}
        onClose={() => setOpenId(null)}
      />
    </Box>
  );
};

export default IntegrationsGallery;
