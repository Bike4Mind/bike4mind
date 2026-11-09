import React, { useMemo } from 'react';
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
  const userIds = useMemo(
    () =>
      Array.from(
        new Set(metrics.map(metric => metric.session?.userId).filter((id): id is string => Boolean(id)))
      ).sort(),
    [metrics]
  );
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
    const unique = (pick: (metric: ModelMetric) => string | undefined) =>
      Array.from(new Set(metrics.map(pick).filter((value): value is string => Boolean(value)))).sort();
    return [
      { id: 'period', label: 'Period', options: PERIOD_OPTIONS },
      {
        id: 'model',
        label: 'Model',
        options: unique(metric => metric.model?.name).map(value => ({
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
  }, [metrics, modelInfos, simplifiedNames, userIds, userNames]);

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
