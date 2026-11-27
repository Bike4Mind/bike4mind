import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { SideAppsResponse, SideAppUsersResponse } from '@client/shared/sideApps';

/** Per-app spend, requests, outcomes and refusals for the admin Side apps view. */
export const useSideApps = (days: number) =>
  useQuery({
    queryKey: ['side-apps', days],
    queryFn: async () => {
      const { data } = await api.get<SideAppsResponse>('/api/admin/side-apps', { params: { days } });
      return data;
    },
    staleTime: 1000 * 60 * 5,
  });

/** One row per user of a connected app; idle until an app is chosen. */
export const useSideAppUsers = (clientId: string | null, days: number) =>
  useQuery({
    queryKey: ['side-apps', 'users', clientId, days],
    enabled: clientId !== null,
    queryFn: async () => {
      const { data } = await api.get<SideAppUsersResponse>(
        `/api/admin/side-apps/${encodeURIComponent(clientId as string)}/users`,
        { params: { days } }
      );
      return data;
    },
    staleTime: 1000 * 60 * 5,
  });
