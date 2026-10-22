import {
  INTEGRATIONS,
  INTEGRATION_CATEGORIES,
  INTEGRATION_CATEGORY_LABELS,
  MODEL_PROVIDERS,
  MODEL_PROVIDER_KIND_LABELS,
  deriveIntegrationStatus,
  type DerivedIntegration,
  type Integration,
  type IntegrationCategory,
  type IntegrationId,
  type IntegrationStatus,
  type IntegrationStatusContext,
  type ModelProvider,
  type ModelProviderKind,
} from '@bike4mind/common';

/** Everything about the viewer that decides what the gallery shows them. */
export interface GalleryViewer extends IntegrationStatusContext {
  canAccessTavern: boolean;
}

export interface ConnectionState {
  connected: boolean;
  /** The grant expired or was revoked: offer Reconnect rather than Connect. */
  needsReconnect?: boolean;
}

export type Connections = Partial<Record<IntegrationId, ConnectionState>>;

export const STATUS_FILTERS = ['all', 'connected', 'available', 'beta', 'coming-soon'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  connected: 'Connected',
  available: 'Available',
  beta: 'Beta',
  'coming-soon': 'Coming soon',
};

/** An entry whose surface only renders for some viewers is left out for everyone else. */
export const isVisibleTo = (integration: Integration, viewer: GalleryViewer): boolean =>
  integration.audience === 'admin' ? viewer.isAdmin : integration.audience === 'tavern' ? viewer.canAccessTavern : true;

export const deriveGallery = (viewer: GalleryViewer, connections: Connections): DerivedIntegration[] =>
  INTEGRATIONS.filter(integration => isVisibleTo(integration, viewer)).map(integration =>
    deriveIntegrationStatus(integration, viewer, connections[integration.id]?.connected ?? false)
  );

export interface GalleryCounts {
  integrations: number;
  models: number;
  roadmap: number;
}

export const galleryCounts = (rows: readonly DerivedIntegration[]): GalleryCounts => ({
  integrations: rows.filter(r => r.status !== 'coming-soon').length,
  models: MODEL_PROVIDERS.length,
  roadmap: rows.filter(r => r.status === 'coming-soon').length,
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const countLine = ({ integrations, models, roadmap }: GalleryCounts): string =>
  `${plural(integrations, 'integration', 'integrations')}, ${plural(models, 'model', 'models')}, ${roadmap} on the roadmap`;

const matchesQuery = (query: string, fields: readonly string[]): boolean => {
  const q = query.trim().toLowerCase();
  return !q || fields.some(field => field.toLowerCase().includes(q));
};

export interface IntegrationFilters {
  query: string;
  category: IntegrationCategory | 'all';
  status: StatusFilter;
}

export const filterIntegrations = (
  rows: readonly DerivedIntegration[],
  { query, category, status }: IntegrationFilters
): DerivedIntegration[] =>
  rows.filter(
    ({ integration, status: rowStatus, betaTag, capabilities }) =>
      (category === 'all' || integration.category === category) &&
      // Beta also finds a connected beta: Connected took its status slot, not its Beta tag.
      (status === 'all' || rowStatus === status || (status === 'beta' && betaTag)) &&
      matchesQuery(query, [
        integration.name,
        integration.description,
        INTEGRATION_CATEGORY_LABELS[integration.category],
        ...capabilities.map(c => c.capability.label),
      ])
  );

/** Categories that have at least one row, in the catalog's display order. */
export const categoriesOf = (rows: readonly DerivedIntegration[]): IntegrationCategory[] =>
  INTEGRATION_CATEGORIES.filter(category => rows.some(r => r.integration.category === category));

export interface IntegrationGroup {
  key: string;
  label: string;
  rows: DerivedIntegration[];
  /** The roadmap group, drawn quieter and last. */
  roadmap: boolean;
}

/** Connected pinned first, then live entries by category, then the roadmap. Empty groups are dropped. */
export const groupIntegrations = (rows: readonly DerivedIntegration[]): IntegrationGroup[] => {
  const live = rows.filter(r => r.status === 'available' || r.status === 'beta');
  const groups: IntegrationGroup[] = [
    { key: 'connected', label: 'Connected', rows: rows.filter(r => r.status === 'connected'), roadmap: false },
    ...categoriesOf(live).map(category => ({
      key: category,
      label: INTEGRATION_CATEGORY_LABELS[category],
      rows: live.filter(r => r.integration.category === category),
      roadmap: false,
    })),
    { key: 'coming-soon', label: 'Coming soon', rows: rows.filter(r => r.status === 'coming-soon'), roadmap: true },
  ];
  return groups.filter(group => group.rows.length > 0);
};

const MODEL_KIND_ORDER: readonly ModelProviderKind[] = ['chat', 'image', 'video', 'music', 'voice'];

export const modelKindsOf = (models: readonly ModelProvider[]): ModelProviderKind[] =>
  MODEL_KIND_ORDER.filter(kind => models.some(m => m.kind === kind));

export const filterModels = (
  models: readonly ModelProvider[],
  { query, kind }: { query: string; kind: ModelProviderKind | 'all' }
): ModelProvider[] =>
  models.filter(
    m =>
      (kind === 'all' || m.kind === kind) &&
      matchesQuery(query, [m.name, m.description, MODEL_PROVIDER_KIND_LABELS[m.kind]])
  );

export interface ModelGroup {
  key: ModelProviderKind;
  label: string;
  rows: ModelProvider[];
}

export const groupModels = (models: readonly ModelProvider[]): ModelGroup[] =>
  modelKindsOf(models).map(kind => ({
    key: kind,
    label: MODEL_PROVIDER_KIND_LABELS[kind],
    rows: models.filter(m => m.kind === kind),
  }));
