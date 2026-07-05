import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { useLogEvent } from './data/analytics';
import { MiscEvents } from '@bike4mind/common';

export function useDownload(url: string, filename: string) {
  const logEvent = useLogEvent();

  return useMutation({
    mutationFn: async () => {
      const res = await api.get(url, {
        responseType: 'blob',
      });

      const objectUrl = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to download files');
      logEvent.mutate({ type: MiscEvents.DOWNLOAD_FAILED });
    },
  });
}
