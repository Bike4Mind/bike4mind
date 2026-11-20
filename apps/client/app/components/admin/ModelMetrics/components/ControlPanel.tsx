import React, { useMemo, useState } from 'react';
import { Stack } from '@mui/joy';
import { useQueries } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { FilterBar, SegmentedControl, type AdminFilter, type AdminListState } from '../../shared';
import { ModelMetric } from '../types';
import { getDisplayName } from '../utils/formatters';
import { PERIOD_OPTIONS, STATUS_OPTIONS } from '../modelMetricsSearch';

interface ControlPanelProps {
  metrics: ModelMetric[];
  modelInfos: unknown[];
  /** Period, model and status; they live in the URL. */
  state: AdminListState;
  onChange: (patch: Partial<AdminListState>) => void;
  /** Kept out of the URL: a user id identifies a person. */
  userFilter: string;
  onUserChange: (userId: string) => void;
  simplifiedNames: boolean;
  onSimplifiedNamesChange: (simplified: boolean) => void;
}

const NAME_OPTIONS = [
  { value: 'short', label: 'Short names' },
  { value: 'full', label: 'Full names' },
] as const;

type SeenOptions = { metrics: ModelMetric[]; models: ReadonlySet<string>; userIds: ReadonlySet<string> };
const EMPTY_SEEN: SeenOptions = { metrics: [], models: new Set(), userIds: new Set() };

function mergeSeen(previous: SeenOptions, metrics: ModelMetric[]): SeenOptions {
  const models = new Set(previous.models);
  const userIds = new Set(previous.userIds);
  for (const metric of metrics) {
    if (metric.model?.name) models.add(metric.model.name);
    if (metric.session?.userId) userIds.add(metric.session.userId);
  }
  return { metrics, models, userIds };
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  metrics,
  modelInfos,
  state,
  onChange,
  userFilter,
  onUserChange,
  simplifiedNames,
  onSimplifiedNamesChange,
}) => {
  // The server filters the rows, so options seen on earlier fetches are kept: otherwise picking a
  // model or user would shrink its own menu to that one value.
  const [seen, setSeen] = useState(() => mergeSeen(EMPTY_SEEN, metrics));
  // Empty rows add nothing, and the parent defaults them to a fresh [] each render.
  if (metrics.length && seen.metrics !== metrics) setSeen(mergeSeen(seen, metrics));

  const userIds = useMemo(() => [...seen.userIds].sort(), [seen]);
  // Same key as useGetUser (userQueryKey), so names are shared with the rest of the admin UI.
  const userNames = useQueries({
    queries: userIds.map(id => ({
      queryKey: ['users', id],
      queryFn: async () => (await api.get<{ username?: string }>(`/api/users/${id}`)).data,
      staleTime: 1000 * 60 * 3,
    })),
    combine: results => results.map(result => result.data?.username),
  });

  const filters = useMemo<AdminFilter[]>(() => {
    return [
      { id: 'period', label: 'Period', options: PERIOD_OPTIONS },
      {
        id: 'model',
        label: 'Model',
        options: [...seen.models].sort().map(value => ({
          value,
          label: getDisplayName(value, modelInfos, simplifiedNames),
        })),
      },
      {
        id: 'user',
        label: 'User',
        options: userIds.map((value, index) => ({ value, label: userNames[index] ?? value })),
      },
      { id: 'status', label: 'Status', options: STATUS_OPTIONS },
    ];
  }, [seen, modelInfos, simplifiedNames, userIds, userNames]);

  return (
    <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1} data-testid="model-metrics-toolbar">
      <FilterBar
        search={false}
        filters={filters}
        state={{ ...state, filters: { ...state.filters, user: userFilter } }}
        onChange={patch => {
          if (patch.filters) onUserChange(patch.filters.user ?? '');
          onChange(patch);
        }}
      />
      <SegmentedControl
        aria-label="Model names"
        data-testid="model-metrics-names"
        options={NAME_OPTIONS}
        value={simplifiedNames ? 'short' : 'full'}
        onChange={value => onSimplifiedNamesChange(value === 'short')}
      />
    </Stack>
  );
};
