import { isAxiosError } from 'axios';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminDataExportDownload, AdminDataExportSummary } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';

// While an export is building, the list re-reads at this interval (ms) so it flips to ready on its own.
const BUILDING_REFETCH_MS = 15_000;

const exportsPath = (userId: string) => `/api/admin/users/${encodeURIComponent(userId)}/data-export`;

export const adminDataExportsQueryKey = (userId: string) => ['admin', 'users', userId, 'data-exports'] as const;

const toastFailure = (error: unknown, fallback: string) => {
  if (isStepUpCancelled(error)) return;
  const message = isAxiosError<{ error?: string }>(error) ? error.response?.data?.error : undefined;
  toast.error(message ?? fallback);
};

export const useAdminDataExports = (userId: string) =>
  useQuery({
    queryKey: adminDataExportsQueryKey(userId),
    queryFn: async () => (await api.get<{ exports: AdminDataExportSummary[] }>(exportsPath(userId))).data.exports,
    refetchInterval: query =>
      query.state.data?.some(entry => entry.status.state === 'building') ? BUILDING_REFETCH_MS : false,
  });

export const useRequestAdminDataExport = (userId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (reason: string) =>
      (await api.post<{ exportJobId: string }>(exportsPath(userId), { reason })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminDataExportsQueryKey(userId) }),
    onError: error => toastFailure(error, 'Could not request the export.'),
  });
};

/** Fetches a five-minute link and hands it to the browser, which downloads the zip as an attachment. */
export const useDownloadAdminDataExport = (userId: string) =>
  useMutation({
    mutationFn: async (exportJobId: string) =>
      (await api.get<AdminDataExportDownload>(`${exportsPath(userId)}/${encodeURIComponent(exportJobId)}`)).data,
    onSuccess: ({ url }) => window.location.assign(url),
    onError: error => toastFailure(error, 'Could not download the export.'),
  });
