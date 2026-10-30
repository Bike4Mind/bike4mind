import { useQuery } from '@tanstack/react-query';
import { fetchLatestDesktopRelease } from '@client/app/utils/desktopReleases';

export const DESKTOP_RELEASE_QUERY_KEY = ['desktopRelease', 'latest'] as const;

/** The newest published desktop release. A failure is expected (rate limit); callers fall back to stable links. */
export function useLatestDesktopRelease() {
  return useQuery({
    queryKey: DESKTOP_RELEASE_QUERY_KEY,
    queryFn: ({ signal }) => fetchLatestDesktopRelease(signal),
    staleTime: 10 * 60 * 1000,
  });
}
