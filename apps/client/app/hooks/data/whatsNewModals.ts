import { api } from '@client/app/contexts/ApiContext';
import { IModalDocument, WhatsNewSyncConfig } from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';
import type { AvailableModalsResponse } from '@pages/api/admin/whats-new/available';
import type { ImportModalsResponse } from '@pages/api/admin/whats-new/import';
import type { SyncConfigResponse } from '@pages/api/admin/whats-new/config';
import type { WhatsNewSyncResult } from '@pages/api/admin/whats-new/sync';
import type { AvailableModalEntry } from '@server/services/whatsNewForkFetcher';

const WHATS_NEW_TAG = 'whats-new';

/**
 * Fetch local What's New modals (filtered by tag).
 */
export function useGetWhatsNewModals() {
  return useQuery({
    queryKey: ['whats-new-modals', 'local'],
    queryFn: async () => {
      const { data } = await api.get<IModalDocument[]>('/api/modals', {
        params: { tags: WHATS_NEW_TAG },
      });
      return data;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 3,
    retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
  });
}

/**
 * Fetch available What's New modals from production S3.
 */
export function useGetAvailableWhatsNewModals() {
  return useQuery({
    queryKey: ['whats-new-modals', 'available'],
    queryFn: async () => {
      const { data } = await api.get<AvailableModalsResponse>('/api/admin/whats-new/available');
      return data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
  });
}

/**
 * Get What's New sync configuration.
 */
export function useGetWhatsNewSyncConfig() {
  return useQuery({
    queryKey: ['whats-new-modals', 'config'],
    queryFn: async () => {
      const { data } = await api.get<SyncConfigResponse>('/api/admin/whats-new/config');
      return data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Update What's New sync configuration.
 */
export function useUpdateWhatsNewSyncConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: Partial<WhatsNewSyncConfig>) => {
      const { data } = await api.put<SyncConfigResponse>('/api/admin/whats-new/config', config);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals', 'config'] });
      toast.success('Sync configuration updated');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to update sync config: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Import specific What's New modals by key.
 */
export function useImportWhatsNewModals() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (modalKeys: string[]) => {
      const { data } = await api.post<ImportModalsResponse>('/api/admin/whats-new/import', {
        modalKeys,
      });
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals'] });
      queryClient.invalidateQueries({ queryKey: ['modals'] });

      const { summary } = data;
      if (summary.imported > 0) {
        toast.success(`Imported ${summary.imported} modal${summary.imported > 1 ? 's' : ''}`);
      }
      if (summary.skipped > 0) {
        toast.info(`${summary.skipped} modal${summary.skipped > 1 ? 's' : ''} already imported`);
      }
      if (summary.failed > 0) {
        toast.error(`${summary.failed} modal${summary.failed > 1 ? 's' : ''} failed to import`);
      }
    },
    onError: (error: unknown) => {
      toast.error(`Failed to import modals: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Sync latest What's New modal from production.
 */
export function useSyncLatestWhatsNewModal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<WhatsNewSyncResult>('/api/admin/whats-new/sync');
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals'] });
      queryClient.invalidateQueries({ queryKey: ['modals'] });

      if (data.imported) {
        toast.success('Latest modal synced successfully');
      } else {
        toast.info(data.reason || 'No new modal to sync');
      }
    },
    onError: (error: unknown) => {
      toast.error(`Failed to sync: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Delete a What's New modal.
 */
export function useDeleteWhatsNewModal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (modalId: string) => {
      await api.delete(`/api/modals/${modalId}/delete`);
      return modalId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals'] });
      queryClient.invalidateQueries({ queryKey: ['modals'] });
      toast.success('Modal deleted');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to delete modal: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Toggle What's New modal enabled status.
 */
export function useToggleWhatsNewModal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ modalId, enabled }: { modalId: string; enabled: boolean }) => {
      const { data } = await api.put<IModalDocument>(`/api/modals/${modalId}/update`, { enabled });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals'] });
      queryClient.invalidateQueries({ queryKey: ['modals'] });
    },
    onError: (error: unknown) => {
      toast.error(`Failed to update modal: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Update What's New modal content.
 */
export function useUpdateWhatsNewModal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      modalId,
      updates,
    }: {
      modalId: string;
      updates: { title?: string; subtitle?: string; description?: string; endDate?: string };
    }) => {
      const { data } = await api.put<IModalDocument>(`/api/modals/${modalId}/update`, updates);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals'] });
      queryClient.invalidateQueries({ queryKey: ['modals'] });
      toast.success('Modal updated successfully');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to update modal: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Fetch raw modal document with all variants populated (admin-gated).
 * The serving endpoint strips variants; this endpoint returns them unredacted for admin use.
 */
export function useGetRawModalVariants(modalId: string | null) {
  return useQuery({
    queryKey: ['admin-modal-variants', modalId],
    queryFn: async () => {
      const { data } = await api.get<IModalDocument>('/api/admin/modals/variants', {
        params: { modalId },
      });
      return data;
    },
    enabled: !!modalId,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Replace the variants map for a modal via the admin authoring endpoint.
 */
export function useUpdateWhatsNewModalVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      modalId,
      variants,
    }: {
      modalId: string;
      variants: Partial<
        Record<string, { title?: string | null; subtitle?: string | null; description?: string | null }>
      >;
    }) => {
      const { data } = await api.put<{ success: boolean; modal: IModalDocument }>('/api/admin/modals/variants', {
        modalId,
        variants,
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals'] });
      queryClient.invalidateQueries({ queryKey: ['modals'] });
      queryClient.invalidateQueries({ queryKey: ['admin-modal-variants'] });
      toast.success('Modal variants updated');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to update variants: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Create a new What's New modal.
 */
export function useCreateWhatsNewModal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (modalData: { title: string; subtitle: string; description: string; endDate?: string }) => {
      const now = new Date();
      // Use provided endDate or default to 30 days from now
      const endDate = modalData.endDate
        ? new Date(modalData.endDate)
        : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const { data } = await api.post<IModalDocument>('/api/modals/create', {
        title: modalData.title,
        subtitle: modalData.subtitle,
        description: modalData.description,
        textMessage: null,
        imageUrl: null,
        tags: [WHATS_NEW_TAG, 'custom'],
        priority: 10,
        closeButton: true,
        agreeButton: true,
        enabled: true,
        isBanner: false,
        startDate: now.toISOString(),
        endDate: endDate.toISOString(),
        numberOfAgrees: null,
        numberOfViews: {
          type: 'firstTimeView',
          value: 0,
          threshold: 1,
          tags: [WHATS_NEW_TAG],
        },
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals'] });
      queryClient.invalidateQueries({ queryKey: ['modals'] });
      toast.success('Modal created successfully');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to create modal: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Weekly Highlights Configuration Response
 */
export interface HighlightsConfigResponse {
  enabled: boolean;
  slackChannelId: string | null;
  slackTeamId: string | null;
  llmModel: string | null;
  promptTemplate: string | null;
  attachMarkdownFile: boolean | null;
  lastRunAt: string | null;
  lastStatus: 'success' | 'failed' | 'no_modals' | null;
  lastHighlights: string | null;
  lastCorrelationId: string | null;
  lastCompletedAt: string | null;
}

/**
 * Get Weekly Highlights configuration.
 */
export function useGetHighlightsConfig() {
  return useQuery({
    queryKey: ['whats-new-highlights', 'config'],
    queryFn: async () => {
      const { data } = await api.get<HighlightsConfigResponse>('/api/admin/whats-new-highlights-config');
      return data;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
  });
}

/**
 * Update Weekly Highlights configuration.
 */
export function useUpdateHighlightsConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: {
      enabled: boolean;
      slackChannelId?: string;
      slackTeamId?: string;
      llmModel?: string;
      promptTemplate?: string;
      attachMarkdownFile?: boolean;
    }) => {
      const { data } = await api.put<{ success: boolean; config: HighlightsConfigResponse }>(
        '/api/admin/whats-new-highlights-config',
        config
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-highlights', 'config'] });
      toast.success('Highlights configuration updated');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to update highlights config: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Trigger manual highlights generation with optional date range and dry run.
 */
export function useGenerateHighlights() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { startDate?: string; endDate?: string; dryRun?: boolean } | void) => {
      const { data } = await api.post<{
        success: boolean;
        message: string;
        correlationId?: string;
        dryRun?: boolean;
        dateRange?: { startDate: string; endDate: string };
        modalCount?: number;
        modals?: Array<{ title: string; subtitle: string; descriptionPreview: string; createdAt: string }>;
      }>('/api/admin/generate-highlights', params || undefined);
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-highlights', 'config'] });
      toast.success(data.message || 'Highlights generation started');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to generate highlights: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Generation Status Response
 */
export interface GenerationStatusResponse {
  lastStatus: 'success' | 'failed' | 'no_changes' | 'skipped' | 'no_prs' | null;
  lastCompletedAt: string | null;
  lastCorrelationId: string | null;
  lastModelUsed: string | null;
  lastGeneratedDate: string | null;
  lastError: string | null;
  lastRunAt: string | null;
}

/**
 * Get What's New generation status.
 */
export function useGetGenerationStatus() {
  return useQuery({
    queryKey: ['whats-new-generation', 'status'],
    queryFn: async () => {
      const { data } = await api.get<GenerationStatusResponse>('/api/admin/whats-new-generation-status');
      return data;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
  });
}

/**
 * Backfill Response
 */
export interface BackfillResponse {
  success: boolean;
  dryRun: boolean;
  queued: string[];
  skipped: string[];
  noPRs: string[];
  failed: string[];
  details: Array<{ date: string; status: string; prCount?: number; reason?: string }>;
}

/**
 * Backfill missed What's New modal generation dates.
 */
export function useBackfillWhatsNew() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { dates: string[]; dryRun?: boolean }) => {
      const { data } = await api.post<BackfillResponse>('/api/admin/whats-new-backfill', params);
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['whats-new-generation', 'status'] });
      queryClient.invalidateQueries({ queryKey: ['whats-new-modals'] });
      if (data.dryRun) {
        toast.success(`Dry run: ${data.queued.length} dates would generate, ${data.skipped.length} already exist`);
      } else {
        toast.success(`Backfill: ${data.queued.length} queued, ${data.skipped.length} skipped`);
      }
    },
    onError: (error: unknown) => {
      toast.error(`Backfill failed: ${getErrorMessage(error)}`);
    },
  });
}

// Re-export types for convenience
export type {
  AvailableModalEntry,
  AvailableModalsResponse,
  ImportModalsResponse,
  SyncConfigResponse,
  WhatsNewSyncResult,
};
