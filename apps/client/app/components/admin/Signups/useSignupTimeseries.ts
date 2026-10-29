import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { SignupTimeseries, SignupTimeseriesRange, SignupVerdicts } from '@client/app/utils/signupSignals';

// Nested under ['users'] so every user mutation's prefix invalidation (create, delete, ...) refreshes the chart.
export const signupTimeseriesQueryKey = (range: SignupTimeseriesRange) =>
  ['users', 'signup-timeseries', range] as const;

/** Signups bucketed at the viewer's local hour or midnight, split by the suspected-signup classifier. */
export function useSignupTimeseries(range: SignupTimeseriesRange) {
  return useQuery({
    queryKey: signupTimeseriesQueryKey(range),
    queryFn: async () =>
      (
        await api.get<SignupTimeseries>('/api/admin/signup-timeseries', {
          // getTimezoneOffset is minutes west of UTC; the endpoint takes minutes east.
          params: { range, tzOffset: -new Date().getTimezoneOffset() },
        })
      ).data,
    staleTime: 60000,
  });
}

/**
 * The chart's verdict for each listed account. `asOf` is the loaded chart's `until`, so the verdicts
 * classify the same cohort at the same instant and refresh only when the chart does.
 */
export function useSignupVerdicts(range: SignupTimeseriesRange, asOf: string | undefined, userIds: readonly string[]) {
  return useQuery({
    queryKey: ['users', 'signup-verdicts', range, asOf, userIds] as const,
    queryFn: async () =>
      (
        await api.get<SignupVerdicts>('/api/admin/users/signup-verdicts', {
          params: { range, asOf, tzOffset: -new Date().getTimezoneOffset(), ids: userIds.join(',') },
        })
      ).data,
    enabled: !!asOf && userIds.length > 0,
    // Fixed by asOf, so a result never goes stale on its own.
    staleTime: Infinity,
  });
}

/** The [start, end) window a bucket covers, as ISO instants for the Users list filter. */
export function bucketWindow(start: string, bucket: SignupTimeseries['bucket']) {
  const from = new Date(start);
  const to = new Date(from.getTime() + (bucket === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
  return { createdFrom: from.toISOString(), createdTo: to.toISOString() };
}

export function formatBucketLabel(start: string, bucket: SignupTimeseries['bucket']) {
  const date = new Date(start);
  return bucket === 'hour'
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
