import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import type { ExportFormat } from '@bike4mind/common';
import type { z } from 'zod';
import type { CurationArtifactTypeSchema } from '@bike4mind/common';

type CurationArtifactTypeAPI = z.infer<typeof CurationArtifactTypeSchema>;

// Types for curation API
interface CurateNotebooksRequest {
  sessionIds: string[];
  curationType?: 'transcript' | 'executive_summary';
  artifactTypes?: CurationArtifactTypeAPI[];
  exportFormat?: ExportFormat;
  customNotebookName?: string;
}

interface CurateNotebooksResponse {
  success: boolean;
  message?: string;
  data: {
    batchJobId: string;
    curationJobs: Array<{
      curationJobId: string;
      sessionId: string;
    }>;
    batchTotal: number;
  };
}

interface DownloadNotebooksRequest {
  sessionIds: string[];
  format: ExportFormat;
  downloadAsZip: boolean;
}

interface DownloadNotebooksResponse {
  success: boolean;
  message?: string;
  data: {
    downloadUrl: string;
    fileName: string;
  };
}

interface SendNotebooksEmailRequest {
  type: 'notebooks';
  sessionIds: string[];
  recipients: string[];
  format: ExportFormat;
  message?: string;
}

interface SendNotebooksEmailResponse {
  success: boolean;
  message: string;
}

/**
 * Hook for curating notebooks (starting the curation process)
 */
export function useCurateNotebooks(callbacks?: {
  onSuccess?: (data: CurateNotebooksResponse['data']) => void;
  onError?: (error: Error) => void;
}) {
  return useMutation({
    mutationFn: async (request: CurateNotebooksRequest) => {
      const response = await api.post<CurateNotebooksResponse>('/api/notebooks/curate', request);
      if (!response.data.success) {
        throw new Error(response.data.message || 'Curation failed');
      }
      return response.data;
    },
    onSuccess: data => {
      toast.info(`Batch curation started for ${data.data.batchTotal} session(s)! Watch progress above...`);
      callbacks?.onSuccess?.(data.data);
    },
    onError: (error: Error) => {
      console.error('Curation error:', error);
      toast.error(error.message || 'Failed to start curation');
      callbacks?.onError?.(error);
    },
  });
}

/**
 * Hook for downloading curated notebooks
 */
export function useDownloadNotebooks(callbacks?: {
  onSuccess?: (data: DownloadNotebooksResponse['data']) => void;
  onError?: (error: Error) => void;
}) {
  return useMutation({
    mutationFn: async (request: DownloadNotebooksRequest) => {
      const response = await api.post<DownloadNotebooksResponse>('/api/notebooks/download', request);
      if (!response.data.success) {
        throw new Error(response.data.message || 'Failed to get download URL');
      }
      return response.data;
    },
    onSuccess: (data, variables) => {
      const { downloadUrl, fileName } = data.data;

      // Create a temporary anchor element to trigger download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      if (variables.downloadAsZip) {
        toast.success(`Download started! ${variables.sessionIds.length} notebooks packaged as ${fileName}`);
      } else {
        toast.success(
          `Download started! Check your files for the curated notebook (${variables.format.toUpperCase()}).`
        );
      }

      callbacks?.onSuccess?.(data.data);
    },
    onError: (error: Error) => {
      console.error('Download error:', error);
      toast.error(error.message || 'Failed to download curated notebooks');
      callbacks?.onError?.(error);
    },
  });
}

/**
 * Hook for sending curated notebooks via email
 */
export function useSendNotebooksEmail(callbacks?: {
  onSuccess?: (message: string) => void;
  onError?: (error: Error) => void;
}) {
  return useMutation({
    mutationFn: async (request: SendNotebooksEmailRequest) => {
      const response = await api.post<SendNotebooksEmailResponse>('/api/email/send', request);
      if (!response.data.success) {
        throw new Error(response.data.message || 'Failed to send email');
      }
      return response.data;
    },
    onSuccess: data => {
      toast.success(data.message);
      callbacks?.onSuccess?.(data.message);
    },
    onError: (error: Error) => {
      console.error('Email error:', error);
      toast.error(error.message || 'Failed to send curated notebooks via email');
      callbacks?.onError?.(error);
    },
  });
}
