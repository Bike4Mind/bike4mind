import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useEffect, useState } from 'react';
import { IImportHistoryJob } from '@bike4mind/database/content';

export interface ListImportHistoryJobsParams {
  status?: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  source?: 'OpenAI' | 'Claude' | 'Notebook';
  page?: number;
  limit?: number;
  orderBy?: string;
  direction?: 'asc' | 'desc';
}

// List all import history jobs for the current user
export function useListImportHistoryJobs(params: ListImportHistoryJobsParams = {}) {
  const { status, source, page = 1, limit = 10, orderBy = 'createdAt', direction = 'desc' } = params;

  return useQuery({
    queryKey: ['import-history-jobs', { status, source, page, limit, orderBy, direction }],
    queryFn: async () => {
      const response = await api.get<{
        success: boolean;
        data: IImportHistoryJob[];
        hasMore: boolean;
        total: number;
      }>('/api/import-history-jobs', {
        params: {
          status,
          source,
          page,
          limit,
          orderBy,
          direction,
        },
      });
      return response.data;
    },
  });
}

// Get a single import history job by ID
export function useGetImportHistoryJob(jobId?: string) {
  return useQuery({
    queryKey: ['import-history-jobs', jobId],
    queryFn: async () => {
      const response = await api.get<{
        success: boolean;
        data: IImportHistoryJob;
      }>(`/api/import-history-jobs/${jobId}`);
      return response.data.data;
    },
    enabled: !!jobId,
    refetchOnWindowFocus: false,
  });
}

// Retry a failed import
export function useRetryImportHistoryJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (jobId: string) => {
      const response = await api.post<{
        success: boolean;
        message: string;
        data: { id: string };
      }>(`/api/import-history-jobs/${jobId}/retry`);
      return response.data;
    },
    onSuccess: (data, jobId) => {
      queryClient.invalidateQueries({ queryKey: ['import-history-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['import-history-jobs', jobId] });
      toast.success('Import retry initiated! 🚀');
    },
    onError: (error: any) => {
      console.error('Failed to retry import:', error);
      toast.error(error.response?.data?.message || 'Failed to retry import');
    },
  });
}

// WebSocket hook for real-time import progress updates
export const useImportHistoryJobWebSocket = (jobId: string | undefined) => {
  const { subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();
  const [liveProgress, setLiveProgress] = useState<{
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    currentStep: string;
    processedItems?: number;
    totalItems?: number;
    errorMessage?: string;
  } | null>(null);

  useEffect(() => {
    if (!jobId) return;

    console.log(`🔌 [WEBSOCKET] Subscribing to import job updates for job: ${jobId}`);

    const unsubscribe = subscribeToAction('import_history_job_progress', async message => {
      console.log(`📨 [WEBSOCKET] Received import progress message:`, message);

      // Check if this is an import job update for our specific job
      if (message.action === 'import_history_job_progress' && message.importHistoryJobId === jobId) {
        console.log(`✅ [WEBSOCKET] Match found for job ${jobId}:`, {
          status: message.status,
          progress: message.progress,
          currentStep: message.currentStep,
        });

        setLiveProgress({
          status: message.status,
          progress: message.progress,
          currentStep: message.currentStep,
          processedItems: message.processedItems,
          totalItems: message.totalItems,
          errorMessage: message.errorMessage,
        });

        // Invalidate query when import is complete or failed
        if (message.status === 'completed' || message.status === 'failed') {
          queryClient.invalidateQueries({ queryKey: ['import-history-jobs', jobId] });
          queryClient.invalidateQueries({ queryKey: ['import-history-jobs'] });
        }
      } else {
        console.log(
          `❌ [WEBSOCKET] Message not for this job. Expected: ${jobId}, Got: ${(message as any).importHistoryJobId}`
        );
      }
    });

    return () => {
      console.log(`🔌 [WEBSOCKET] Unsubscribing from import job updates for job: ${jobId}`);
      unsubscribe();
    };
  }, [jobId, subscribeToAction, queryClient]);

  return liveProgress;
};
