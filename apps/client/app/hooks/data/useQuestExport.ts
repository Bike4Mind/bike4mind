import { useState, useEffect, useCallback, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { toast } from 'sonner';
import { IQuestExportProgressAction } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';

interface QuestExportState {
  exportJobId: string | null;
  planId: string | null;
  status: IQuestExportProgressAction['status'] | 'idle';
  progress: number;
  detail: string;
  downloadUrl: string | null;
  errorMessage: string | null;
}

const initialState: QuestExportState = {
  exportJobId: null,
  planId: null,
  status: 'idle',
  progress: 0,
  detail: '',
  downloadUrl: null,
  errorMessage: null,
};

export function useQuestExport() {
  const { subscribeToAction } = useWebsocket();
  const [state, setState] = useState<QuestExportState>(initialState);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const startExportMutation = useMutation({
    mutationFn: async (planId: string) => {
      const { data } = await api.post<{ success: boolean; exportJobId: string; planId: string }>(
        `/api/quest-plans/${planId}/export`
      );
      return data;
    },
    onSuccess: data => {
      setState({
        exportJobId: data.exportJobId,
        planId: data.planId,
        status: 'assembling',
        progress: 5,
        detail: 'Starting export...',
        downloadUrl: null,
        errorMessage: null,
      });
      toast.info('Quest export started');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error) || 'Failed to start export');
    },
  });

  // Subscribe to WebSocket progress updates
  useEffect(() => {
    if (!state.exportJobId) return;

    // Clean up previous subscription
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
    }

    const unsubscribe = subscribeToAction('quest_export_progress', async (data: unknown) => {
      const msg = data as IQuestExportProgressAction;

      // Only handle messages for our current export job
      if (msg.exportJobId !== state.exportJobId) return;

      setState(prev => ({
        ...prev,
        status: msg.status,
        progress: msg.progress,
        detail: msg.detail || prev.detail,
        downloadUrl: msg.downloadUrl || prev.downloadUrl,
        errorMessage: msg.errorMessage || prev.errorMessage,
      }));

      if (msg.status === 'completed' && msg.downloadUrl) {
        const url = msg.downloadUrl;
        const filename = msg.filename || 'quest-export.zip';
        triggerDownload(url, filename);
        toast.success(`Export complete: ${filename}`, {
          duration: 10000,
          action: {
            label: 'Download Again',
            onClick: () => triggerDownload(url, filename),
          },
        });
      } else if (msg.status === 'failed') {
        toast.error(msg.errorMessage || 'Export failed');
      }
    });

    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
      unsubscribeRef.current = null;
    };
  }, [state.exportJobId, subscribeToAction]);

  const startExport = useCallback(
    (planId: string) => {
      startExportMutation.mutate(planId);
    },
    [startExportMutation]
  );

  const dismiss = useCallback(() => {
    setState(initialState);
  }, []);

  const isExporting = state.status !== 'idle' && state.status !== 'completed' && state.status !== 'failed';

  return {
    ...state,
    isExporting,
    isStarting: startExportMutation.isPending,
    startExport,
    dismiss,
  };
}

function triggerDownload(url: string, filename?: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'quest-export.zip';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
